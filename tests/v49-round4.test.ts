// Полный отчет на два показателя и найденные дефекты отчета.
//
// Каждое ЧИСЛО и каждое УТВЕРЖДЕНИЕ О ДАННЫХ проверяется ПОВЕДЕНЧЕСКИ – на
// фикстурных картах, через модель и MD-рендер, а не чтением исходника:
// проверка исходника не ловит дефект смысла.
import { describe, expect, test } from "bun:test";
import { buildReportModel } from "../src/report/build";
import { renderRepoReport } from "../src/report/markdown";
import { fixtureCard, type ReportFixture } from "./report-fixtures";

/** MD фикстуры и ее модель — на один тест. */
function report(name: ReportFixture): { md: string; model: ReturnType<typeof buildReportModel> } {
  const { card, close } = fixtureCard(name);
  try {
    return { md: renderRepoReport(card), model: buildReportModel(card) };
  } finally {
    close();
  }
}

const heroOf = (model: ReturnType<typeof buildReportModel>) => {
  const hero = model.blocks.find((b) => b.kind === "hero");
  if (hero?.kind !== "hero") throw new Error("нет первого экрана");
  return hero;
};

const bars = (model: ReturnType<typeof buildReportModel>) => model.blocks.filter((b) => b.kind === "contributions").map((b) => (b.kind === "contributions" ? b.title : ""));

/**
 * Таблицы приложения А по порядку. Когда таблиц две, показатель
 * назван подзаголовком («Расчет <показатель>»), а столбец — просто «Вес»;
 * когда таблица одна, подзаголовка нет и показатель стоит в шапке столбца.
 */
const calcTables = (model: ReturnType<typeof buildReportModel>) => {
  const out: string[] = [];
  let subhead: string | null = null;
  for (const b of model.blocks) {
    if (b.kind === "paragraph" && b.tone === "subhead") subhead = b.lines[0]!.map((f) => f.text).join("");
    if (b.kind === "table" && b.columns[0]?.title === "Категория") {
      out.push(subhead ?? b.columns[2]!.title);
      subhead = null;
    }
  }
  return out;
};

/** Шапка столбца веса в таблицах приложения А. */
const weightColumns = (model: ReturnType<typeof buildReportModel>) =>
  model.blocks.filter((b) => b.kind === "table" && b.columns[0]?.title === "Категория").map((b) => (b.kind === "table" ? b.columns[2]!.title : ""));

// ---------------------------------------------------------------------------
// Сначала публичный показатель, потом полный
// ---------------------------------------------------------------------------

describe("А1 (блок А): полный отчет считает ОБА показателя, публичный первым", () => {
  test("full: ряд первого экрана – Index слева, Score справа; обе шкалы объяснены", () => {
    const { md, model } = report("full");
    const hero = heroOf(model);
    expect({ left: hero.label, right: hero.secondary?.label }).toEqual({ left: "HealthCraft Index", right: "Repo Health Score" });
    expect({ leftValue: hero.value, rightValue: hero.secondary?.value }).toEqual({ leftValue: 60, rightValue: 61 }); // открытая critical: Безопасность не выше 40
    // строка-пояснение одна и начинается с публичного показателя
    expect(hero.notes.filter((n) => n.info === true)).toHaveLength(1);
    expect(hero.notes.at(-1)!.line.map((f) => f.text).join("")).toStartWith("HealthCraft Index считается по открытым данным");
  });

  test("full: полос вклада две, публичная первой, и каждая складывается в СВОЙ показатель", () => {
    const { model } = report("full");
    expect(bars(model)).toEqual(["Вклад категорий в HealthCraft Index", "Вклад категорий в Repo Health Score"]);
    const hero = heroOf(model);
    const values = [hero.value!, hero.secondary!.value!];
    model.blocks
      .filter((b) => b.kind === "contributions")
      .forEach((b, i) => {
        if (b.kind !== "contributions") return;
        const tenths = b.segments.reduce((s, x) => s + Math.round(Number(x.value.replace("+", "").replace(",", ".")) * 10), 0);
        expect({ bar: b.title, tenths }).toEqual({ bar: b.title, tenths: values[i]! * 10 });
        expect({ bar: b.title, rest: Number(b.rest!.value) }).toEqual({ bar: b.title, rest: 100 - values[i]! });
      });
  });

  test("full: приложение А – две таблицы, публичная первой; приложение Б – две верхние строки", () => {
    const { md, model } = report("full");
    expect(calcTables(model)).toEqual(["Расчет HealthCraft Index", "Расчет Repo Health Score"]);
    // показатель назван подзаголовком, в шапке столбца его нет
    expect(weightColumns(model)).toEqual(["Вес", "Вес"]);
    const appendix = md.slice(md.indexOf("## Приложение"));
    expect(appendix).toContain("| **HealthCraft Index 60** | сумма по 4 открытым категориям: балл × вес, приложение А |");
    expect(appendix).toContain("| **Repo Health Score 61** | сумма по 6 категориям: балл × вес, приложение А |");
    expect(appendix.indexOf("**HealthCraft Index 60**")).toBeLessThan(appendix.indexOf("**Repo Health Score 61**"));
    // строки категорий и подметрик — одинарные: балл категории у обеих шкал один
    expect(appendix.match(/\| \*\*Документация 55\*\* \|/g) ?? []).toHaveLength(1);
    expect(appendix.match(/\| Лицензия: есть \|/g) ?? []).toHaveLength(1);
  });

  test("anon: отчет зрителя без прав остается ОДНОЧИСЛОВЫМ (граница круга 4)", () => {
    const { model } = report("anon");
    const hero = heroOf(model);
    expect({ label: hero.label, secondary: hero.secondary }).toEqual({ label: "HealthCraft Index", secondary: null });
    expect(bars(model)).toEqual(["Вклад категорий в HealthCraft Index"]);
    expect(calcTables(model)).toEqual(["Вес в HealthCraft Index"]);
    expect(weightColumns(model)).toEqual(["Вес в HealthCraft Index"]);
  });
});

describe("А2 (блок А): «Как считается» описывает показатели ЭТОГО документа", () => {
  test("full: первая строка не говорит про 4 категории – в документе их шесть и два показателя", () => {
    const { md } = report("full");
    const method = md.slice(md.indexOf("## Как считается"), md.indexOf("## Приложение"));
    expect(method).toContain("В отчете 2 показателя: HealthCraft Index – по 4 открытым категориям");
    expect(method).not.toContain("Оценка складывается из 4 категорий");
    // у каждого показателя своя строка «В этом отчете: …»
    expect(method.match(/В этом отчете: /g) ?? []).toHaveLength(2);
  });

  test("anon: у зрителя без прав первая строка прежняя – показатель один, категорий четыре", () => {
    const { md } = report("anon");
    const method = md.slice(md.indexOf("## Как считается"), md.indexOf("## Приложение"));
    expect(method).toContain("Оценка складывается из 4 категорий");
    expect(method.match(/В этом отчете: /g) ?? []).toHaveLength(1);
  });

  test("full-null: показатель один – Repo Health Score, и строка говорит про 6 категорий", () => {
    const { md } = report("full-null");
    const method = md.slice(md.indexOf("## Как считается"), md.indexOf("## Приложение"));
    // правило цифр: «1 показатель», не «один»
    expect(method).toContain("В отчете 1 показатель – Repo Health Score");
    expect(method).not.toContain("один показатель");
    expect(method.match(/В этом отчете: /g) ?? []).toHaveLength(1);
  });
});

describe("Блок А, пункт 7: полный доступ есть, HealthCraft Index NULL", () => {
  test("full-null: слева «Оценки нет» без полосы, справа Score со своей полосой; ветка «оценки нет» не выбрана", () => {
    const { md, model } = report("full-null");
    const hero = heroOf(model);
    expect({ left: hero.label, leftValue: hero.value, right: hero.secondary?.label }).toEqual({ left: "HealthCraft Index", leftValue: null, right: "Repo Health Score" });
    expect(hero.secondary!.value).toBe(84);
    // документ остается отчетом С оценкой: разделы «Категории» и «Рекомендации»,
    // а не «Данные по категориям» / «Что сделать» ветки `indexNullSection`
    expect(md).toContain("## Категории");
    expect(md).toContain("## Рекомендации");
    expect(md).not.toContain("## Данные по категориям");
    expect(md).not.toContain("## Объем собранных данных");
    // полоса и таблица приложения А — только у Score
    expect(bars(model)).toEqual(["Вклад категорий в Repo Health Score"]);
    expect(calcTables(model)).toEqual(["Вес в Repo Health Score"]);
    expect(weightColumns(model)).toEqual(["Вес в Repo Health Score"]);
    expect(md.slice(md.indexOf("### Б."))).not.toContain("**HealthCraft Index");
    // и читателю сказано, почему индекса нет
    expect(hero.notes.at(-1)!.line.map((f) => f.text).join("")).toContain("открытых данных собрано меньше 40%, поэтому он не рассчитан");
  });
});

// ---------------------------------------------------------------------------
// Дефекты отчета, найденные аудитом
// ---------------------------------------------------------------------------

describe("А3: «0 за окно» при ненулевом счетчике – ограничение данных, а не факт", () => {
  test("full: строка про непереданные даты стоит в «Ограничениях данных» и называет счетчики", () => {
    const { md } = report("full");
    const limits = md.slice(md.indexOf("## Ограничения данных"), md.indexOf("## Разбор"));
    expect(limits).toContain("Дат событий SourceCraft не передал: релизов по счетчику 1, открытых предложений изменений по счетчику 1");
    // балл не объявляется неверным — сказано только, откуда взялся 0
    expect(limits).toContain("поэтому в разборе у них 0");
    expect(limits).not.toContain("неверн");
  });

  test("full-null: счетчиков нет – строки тоже нет", () => {
    const { md } = report("full-null");
    expect(md).not.toContain("Дат событий SourceCraft не передал");
  });
});

describe("А4: причина отсутствия результатов CI – одна, из самого факта", () => {
  test("grant-ci: причина названа теми же словами в разборе и в приложении В", () => {
    const { md } = report("grant-ci");
    // конфиг CI без видимых прогонов – «нет данных», а не потолок 50
    expect(md).toContain("Результаты запусков CI сервису не видны – категорию не оцениваем");
    const appendix = md.slice(md.indexOf("## Приложение"));
    expect(appendix).toContain("| reason | у сервиса нет прав на эти данные |");
    expect(appendix).not.toContain("| reason | access |");
  });

  test("full: результаты запусков получены – строки про отказ нет", () => {
    const { md } = report("full");
    expect(md).not.toContain("Результаты запусков CI сервис не получил");
  });
});

describe("А5: номинальный вес разбора и перенормированный вес приложения объяснены", () => {
  test("grant-ci: у CI/CD без прогонов категория честно исключена (23.09, кап 50 удалён)", () => {
    // в фикстуре `grant-ci` перенормировка есть у CI/CD (два показателя без данных)
    const { md } = report("grant-ci");
    expect(md).toContain("Результаты запусков CI сервису не видны – категорию не оцениваем");
    expect(md).toContain("Категории без данных в оценке не участвуют и ее не снижают.");
  });

  test("full-null: у «Состояния кода» без доли старых TODO номинальный и расчетный вес названы оба", () => {
    // 0 пометок – это данные («старых нет»); доля без данных бывает только при
    // неполной выборке TODO – ее и моделирует правка карточки
    const { card, close } = fixtureCard("full-null");
    let md: string;
    try {
      const code = card.score!.categories.code!;
      const subs = { ...code.submetrics, old_share: { ...code.submetrics.old_share!, score: null, value: null } };
      md = renderRepoReport({ ...card, score: { ...card.score!, categories: { ...card.score!.categories, code: { ...code, submetrics: subs } } } });
    } finally {
      close();
    }
    // в разборе по категориям стоит номинальный вес показателя
    expect(md).toContain("| Плотность TODO/FIXME в коде | 0 на 1 тыс. строк | 100 | 35% |");
    // в расчете категории — доля среди показателей с данными, и разница объяснена
    const calc = md.slice(md.indexOf("**Балл категории Состояние кода**"));
    expect(calc).toContain("| Плотность TODO/FIXME в коде | 100,0 | 77,8% | 77,8 |");
    expect(calc).toContain(
      "Показатель без данных в расчет не идет, его вес делится между остальными пропорционально, поэтому доли здесь отличаются от номинальных: у «Плотность TODO/FIXME в коде» номинальный вес 35% (он и стоит в разборе по категориям), в расчете – 77,8%.",
    );
  });
});

describe("А6: служебных ветвей и английских значений в приложении В нет", () => {
  test("full: `provenance.*` не печатается, дубль дерева канального скана снят, данные не вычищены", () => {
    const { md } = report("full");
    const appendix = md.slice(md.indexOf("## Приложение"));
    expect(appendix).not.toContain("provenance");
    expect(appendix).not.toContain("tree.stats@channel");
    // сырые значения на месте: путь «число → факт» требует их показывать
    expect(appendix).toContain("| severity_counts.critical | 1 |");
    expect(appendix).toContain("| backlog.open_findings | 7 |");
    expect(appendix).toContain("| last_status | успешно |");
    expect(appendix).not.toContain("| last_status | success |");
  });
});

describe("А7: объем собранных данных пересчитывается по самому документу", () => {
  test("null: «65 весовых пунктов» нет, вместо него – расчет строками приложения А", () => {
    const { md } = report("null");
    expect(md).not.toContain("65 весовых пунктов");
    const appendix = md.slice(md.indexOf("## Приложение"));
    expect(appendix).toContain("**Объем собранных данных**");
    expect(appendix).toContain("| Задачи | 15 | есть | 15 |");
    expect(appendix).toContain("| Документация | 15 | нет | – |");
    expect(appendix).toContain("| Итого | 65 |   | 15 |");
    expect(appendix).toContain("15 ÷ 65 = 23%");
    expect(appendix).toContain("вес открытых категорий с данными ÷ вес 4 открытых категорий, приложение А");
  });
});

describe("А8: окно частоты коммитов объявлено и число пересчитывается", () => {
  test("full: «1 в месяц» выводится из коммитов за 90 дней, а не из коммитов за год", () => {
    const { md } = report("full");
    const activity = md.slice(md.indexOf("### Активность"), md.indexOf("### Задачи"));
    expect(activity).toContain("Частота коммитов считается по последним 90 дням: 3 ÷ 3 = 1 в месяц.");
    expect(activity).toContain("Коммиты за год – 6");
  });
});

describe("А9: плотность находок пересчитывается по приложению", () => {
  test("full: «38 на 10 тыс. строк» разложено на веса важности и строки кода", () => {
    const { md } = report("full");
    const security = md.slice(md.indexOf("### Безопасность"), md.indexOf("### Активность"));
    expect(security).toContain("| Плотность находок | 38 на 10 тыс. строк (действие 1) | 1 | 40% |");
    expect(security).toContain("Находки считаются с весом важности: критичная 1 × 8, высокая 1 × 4, средняя 2 × 2, низкая 3 × 1 = 19 на 5000 строк кода, то есть 38 на 10 тыс. строк.");
  });
});

// UX 17.10: «Трекер не ведется» → «Задачи не ведутся», «задач в трекере нет» → «задач нет»
describe("А10: «Задачи не ведутся» не справочный – его балл и есть балл категории", () => {
  test("grant-ci: в приложении Б у показателя названа его роль в балле категории", () => {
    const { md } = report("grant-ci");
    const appendix = md.slice(md.indexOf("## Приложение"));
    expect(appendix).toContain("| Задачи не ведутся: открытых 0, закрытых 0 | задач нет: балл категории равен баллу этого показателя, приложение А |");
    expect(appendix).not.toMatch(/\| Задачи не ведутся[^|]*\| справочно, в балл не входит \|/);
  });
});

describe("А11: оговорка про обрезанную историю стоит только там, где обрезка была", () => {
  test("anon: отсечение 16 авг. 2025 раньше первого коммита 2 окт. 2025 – оговорки нет", () => {
    const { md } = report("anon");
    expect(md).not.toContain("История коммитов загружена частично");
    const appendix = md.slice(md.indexOf("## Приложение"));
    // данные на месте: и дата отсечения, и первый коммит — читатель проверяет сам
    expect(appendix).toContain("| history_truncated_since | 16 авг. 2025 |");
    // UX 17.10: дата и время; аудит 20.10 — по Москве: 10:00 UTC → «2 окт. 2025, 13:00 МСК»
    expect(appendix).toContain("| first | 2 окт. 2025, 13:00 МСК |");
    // поле `truncated` стоит «да» у каждого анализа — это форма ответа, и так и подписано
    expect(appendix).toContain("| truncated – поле ответа: сами коммиты в документ не выгружаются, показан итог | да |");
  });

  test("отсечение не раньше первого коммита – оговорка печатается (Д4 круга 1 не откатывается)", () => {
    // `cardFacts`: первый коммит 16 авг. 2025, отсечение той же датой
    const { md } = report("full");
    expect(md).not.toContain("История коммитов загружена частично");
    const { md: anonMd } = report("anon");
    expect(anonMd).not.toContain("История коммитов загружена частично");
  });
});

describe("А12: поля выборки TODO подписаны – «старых» не больше, чем «всего»", () => {
  test("full: count, fixme и older_180d названы разными вещами", () => {
    const { md } = report("full");
    const appendix = md.slice(md.indexOf("## Приложение"));
    expect(appendix).toContain("| count – пометок TODO в коде (без файлов тестов), без FIXME | 4 |");
    expect(appendix).toContain("| fixme – пометок FIXME в коде (без файлов тестов) | 1 |");
    expect(appendix).toContain("| older_180d – пометок TODO и FIXME старше 180 дней (из count + fixme) | 2 |");
    // и в разборе итог сходится: 4 + 1 = 5
    expect(md).toContain("Пометок TODO/FIXME в коде – 5");
  });
});

describe("А13: срок закрытия задач назван ОДНИМ числом", () => {
  test("full: действие, строка категории, таблица и приложение дают 48,8 дня", () => {
    const { md } = report("full");
    expect(md).toContain("Типичный срок закрытия задачи – 48,8 дня.");
    expect(md).toContain("Медиана времени закрытия – 48,8 дня.");
    expect(md).toContain("| Медиана времени закрытия | 48,8 дня (действие 7) | 41 | 30% |");
    expect(md).not.toContain("49 дней");
  });
});

describe("А14: язык подписан источником", () => {
  test("null: репозиторий не скачался, а язык есть – потому что он из каталога", () => {
    const { md } = report("null");
    expect(md).toContain("Репозиторий не удалось скачать");
    expect(md).toContain("| Язык (по каталогу SourceCraft) | C++ |");
    expect(md).not.toContain("| Язык | C++ |");
  });
});

describe("А15: выборка задач для времени ответа – не число задач трекера", () => {
  test("grant-ci: пустой трекер и пустая выборка; поле подписано", () => {
    const { md } = report("grant-ci");
    // UX 17.10: проблема называет раздел «Задачи», а не трекер
    expect(md).toContain("В разделе «Задачи» нет ни одной задачи.");
    const appendix = md.slice(md.indexOf("## Приложение"));
    expect(appendix).toContain("| open | 0 |");
    // длинное тире – только глиф «нет данных», в подписи среднее
    expect(appendix).toContain("| issues – задач в выборке для времени первого ответа; число задач трекера – в issues.stats | 0 |");
  });

  test("full: у репозитория с задачами выборка подписана тем же именем", () => {
    const { md } = report("full");
    const appendix = md.slice(md.indexOf("## Приложение"));
    expect(appendix).toContain("| issues – задач в выборке для времени первого ответа; число задач трекера – в issues.stats | 4 |");
  });
});
