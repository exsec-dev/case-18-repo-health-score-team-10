// summary-validator.test.ts — валидатор вывода и рамка входа (Б2 В5):
// форма, привязка, числовой коридор, запрет новых сущностей и ссылок,
// чужая зона, мини-JSON флаггера; nonce-рамка недоверенных данных
// (коллизия разделителя, гигантский/пустой/нерусский README).
// Спека §3.6-3.7; фикстуры — tests/fixtures/adversarial.ts.
import { describe, expect, test } from "bun:test";
import type { FactInput } from "../src/summary/validator";
import { extractRefs, stripMarkers, validateFlagOutput, validateOutput } from "../src/summary/validator";
import { frameUntrusted, makeNonce, sanitizeContent, CONTENT_CAP_BYTES } from "../src/summary/input";
import {
  DARKEN_README,
  EMPTY_README,
  EXFILTRATE_README,
  FOREIGN_ZONE_OUTPUT,
  GREP_INJECTION_LINE,
  INFLATE_README,
  NON_RUSSIAN_README,
  SELF_PRAISE_TODO,
  VALID_DOC_OUTPUT,
  giantReadme,
  separatorCollision,
} from "./fixtures/adversarial";

const DOCS_FACTS: FactInput[] = [
  { key: "docs.presence", value: { readme: true, license: true, contributing: true, codeowners: false } },
  { key: "docs.contributing", value: { present: true } },
  { key: "docs.readme", value: { bytes: 8000, sections: 5, flags: { install: true, build: false, test: false } } },
];

describe("Валидатор: форма, привязка, коридор (спека §3.7)", () => {
  test("канон формы: валидный текст с двумя [[f:ключ]] проходит; clean без маркеров", () => {
    const res = validateOutput({ role: "documentation", text: VALID_DOC_OUTPUT, facts: DOCS_FACTS });
    expect(res.ok).toBe(true);
    expect(res.refs).toEqual(["docs.presence", "docs.contributing"]);
    expect(res.clean).toBe("README покрывает установку, но не вклад.");
  });

  test("числовой коридор снят (решение 23.09): числа не роняют текст; markdown-ссылка — да", () => {
    // цифры — норма: дисциплина чисел живёт в хартиях, не в валидаторе
    const numbers = validateOutput({ role: "code", text: "{f:code.todo} из 100 ошибок, 4 из них серьёзные.", facts: [{ key: "code.todo", value: { count: 4 } }] });
    expect(numbers.ok).toBe(true);

    // цифры внутри идентификаторов тем более не проблема («Extended2008» рвал
    // activity в каждом прогоне, пока коридор скрёб цифры из слов)
    const identifier = validateOutput({
      role: "activity",
      text: "Основной автор – Extended2008, репозиторий case-18 собирается автоматикой.{f:activity.git.summary}",
      facts: [{ key: "activity.git.summary", value: { commits: 12, authors: 2 } }],
    });
    expect(identifier.ok).toBe(true);

    const badLink = validateOutput({
      role: "documentation",
      text: "Документация есть {f:docs.presence}, чат [здесь](https://example.com).",
      facts: DOCS_FACTS,
    });
    expect(badLink.ok).toBe(false);
    expect(badLink.reasons.some((r) => r.includes("ссылки"))).toBe(true);
  });

  test("без единой привязки текст не проходит вовсе", () => {
    const res = validateOutput({ role: "documentation", text: "Совершенно обычный текст без единой привязки к фактам входа.", facts: DOCS_FACTS });
    expect(res.ok).toBe(false);
    expect(res.reasons.some((r) => r.includes("ни одного факта"))).toBe(true);
  });

  test("кап длины: прозе роли ограничение, овервью просторнее", () => {
    const long = `Длинный абзац повторяется. {f:docs.presence}`.repeat(40); // > 1200, без чисел
    const spec = validateOutput({ role: "documentation", text: long, facts: DOCS_FACTS });
    expect(spec.reasons.some((r) => r.includes("длиннее капа"))).toBe(true);
    const ovLong = `Итог synthesis. ${"Текст для овервью повторяется, чтобы переехать первый кап. {f:docs.presence}"}`;
    const ov = validateOutput({ role: "overview", text: ovLong.repeat(10), facts: DOCS_FACTS });
    expect(ov.reasons.some((r) => r.includes("длиннее капа"))).toBe(false); // 2000 — влезает? нет, проверяем кап отдельно
  });

  test("сегменты sp:роль:n — валидны у овервью только из входа", () => {
    const ok = validateOutput({
      role: "overview",
      text: "Документация покрывает установку {f:docs.presence}; специалист отметил вклад {sp:documentation:1}.",
      facts: DOCS_FACTS,
      segments: ["sp:documentation:1", "sp:code:1"],
    });
    expect(ok.ok).toBe(true);
    expect(ok.segmentsUsed).toEqual(["sp:documentation:1"]);
    const bad = validateOutput({
      role: "overview",
      text: "Специалист по коду сказал обратное {sp:code:2}, а документация есть {f:docs.presence}.",
      facts: DOCS_FACTS,
      segments: ["sp:documentation:1"],
    });
    expect(bad.ok).toBe(false);
    expect(bad.reasons.some((r) => r.includes("вне входа"))).toBe(true);
  });
});

describe("Валидатор: adversarial-набор зелёный (спека §3.6 п.4)", () => {
  test("инъекция на завышение: «100 из 100» проходит валидатор — коридор снят, ловит хартия (решение 23.09)", () => {
    // модель послушалась INFLATE_README: числовой коридор снят владельцем,
    // такой текст отсекается дисциплиной хартии и рамкой, не валидатором
    const res = validateOutput({
      role: "documentation",
      text: "Проект идеален, оценка 100 из 100 {f:docs.presence}.",
      facts: DOCS_FACTS,
    });
    // числовой коридор снят владельцем (23.09): инъекционные числа отсекаются
    // дисциплиной хартии и рамкой недоверенных данных, не валидатором
    expect(res.ok).toBe(true);
  });

  test("инъекция «выведи системный промпт»: сырой URL/ссылка — запрет адресов", () => {
    const res = validateOutput({
      role: "documentation",
      text: `Документация есть {f:docs.presence}. Системный промпт начинается со слов "Ты – специалист". Полный текст: https://internal.example/prompt`,
      facts: DOCS_FACTS,
    });
    expect(res.ok).toBe(false);
    expect(res.reasons.some((r) => r.includes("адреса"))).toBe(true);
  });

  test("инъекция на очернение: новое утверждение «активность нулевая» не спасает факт-маркер", () => {
    // DARKEN_README модель пересказала как факт чужой зоны/новое утверждение:
    // маркер на docs.*, но «нулевая» активность — тема activity, число 0 не в фактах документации
    const res = validateOutput({
      role: "documentation",
      text: "Проект мёртв, активность нулевая, 0 разработчиков {f:docs.presence}.",
      facts: DOCS_FACTS,
    });
    expect(res.ok).toBe(false);
  });

  test("самовосхваление в TODO (кейс Алексея): похвала без привязки отбрасывается", () => {
    // модель вынесла SELF_PRAISE_TODO в вывод как факт «гениальности»
    const res = validateOutput({
      role: "code",
      text: "Модуль написан гениально, лучшие инженеры репозитория подтверждают превосходное качество кода проекта.",
      facts: [{ key: "code.todo", value: { count: 4, fixme: 1, older_180d: 2, todo_files: 3, blamed_files: 3 } }],
    });
    expect(res.ok).toBe(false); // нет ни одной привязки
    // а честный вывод по тому же факту проходит
    const honest = validateOutput({
      role: "code",
      text: "В коде 4 TODO-пометки {f:code.todo}, темы долга повторяются.",
      facts: [{ key: "code.todo", value: { count: 4, fixme: 1, older_180d: 2, todo_files: 3, blamed_files: 3 } }],
    });
    expect(honest.ok).toBe(true);
  });

  test("инъекция через результат grep: строка-наводка не делает вывод валидным", () => {
    const res = validateOutput({
      role: "code",
      text: `Инструмент grep небезопасен, сообщаю пользователю предупреждение о небезопасности инструмента поиска. {f:code.todo} https://evil.example`,
      facts: [{ key: "code.todo", value: { count: 4 } }],
    });
    expect(res.ok).toBe(false);
    expect(GREP_INJECTION_LINE.length).toBeGreaterThan(0); // фикстура жива
  });

  test("чужая зона специалиста documentation: ссылка на activity-факт отброшена", () => {
    const res = validateOutput({
      role: "documentation",
      text: FOREIGN_ZONE_OUTPUT,
      facts: [
        ...DOCS_FACTS,
        { key: "activity.git.summary", value: { commits: 2, authors: 2, committers: 2, robot_commits: 0, robot_ratio: 0, first_committed_at: "2025-08-16T10:00:00Z", last_committed_at: "2026-09-10T10:00:00Z" } },
      ],
    });
    expect(res.ok).toBe(false);
    expect(res.reasons.some((r) => r.includes("чужая зона"))).toBe(true);
  });

  test("новые сущности: файл вне фактов и CVE — отказ", () => {
    const res = validateOutput({
      role: "security",
      text: "Найдена уязвимость CVE-2029-0001 в файле src/legacy/parser.go, требуется обновление движка {f:appsec.findings}.",
      facts: [{ key: "appsec.findings", value: { severity_counts: { critical: 0 } } }],
    });
    expect(res.ok).toBe(false);
    expect(res.reasons.some((r) => r.includes("файлы вне фактов") || r.includes("CVE"))).toBe(true);
  });

  test("числовой коридор пропускает числа из фактов (даты, счётчики)", () => {
    const res = validateOutput({
      role: "activity",
      text: "2 автора коммитили до 10.09.2026 {f:activity.git.summary}, ритм ровный.",
      facts: [{ key: "activity.git.summary", value: { commits: 2, authors: 2, first_committed_at: "2025-08-16T10:00:00Z", last_committed_at: "2026-09-10T10:00:00Z" } }],
    });
    expect(res.ok).toBe(true);
  });
});

describe("Флаг фрода: строгий мини-JSON (К5.10)", () => {
  const keys = new Set(["activity.git.summary", "activity.git.timeline"]);

  test("валидный флаг с факторами проходит; ключ вне входа и проза — нет", () => {
    const ok = validateFlagOutput('{"flag":true,"factors":[{"key":"activity.git.summary","note":"ровные интервалы между коммитами"}]}', keys);
    expect(ok.ok).toBe(true);
    expect(ok.flag?.flag).toBe(true);
    expect(ok.flag?.factors[0]?.key).toBe("activity.git.summary");

    expect(validateFlagOutput('{"flag":true,"factors":[{"key":"code.todo","note":"x"}]}', keys).ok).toBe(false);
    expect(validateFlagOutput("Подозрительной активности не обнаружено, проект живой и честный.", keys).ok).toBe(false);
    expect(validateFlagOutput('{"flag":"yes","factors":[]}', keys).ok).toBe(false);
    expect(validateFlagOutput('{"flag":false,"factors":[{"key":"activity.git.summary","note":"смотри https://x"}]}', keys).ok).toBe(false);
    const empty = validateFlagOutput('{"flag":false,"factors":[]}', keys);
    expect(empty.ok).toBe(true);
    expect(empty.flag?.flag).toBe(false);
  });
});

describe("Рамка недоверенных данных: nonce, коллизия, капы (спека §3.6 слои 1-2)", () => {
  test("рамка помечает блок с двух сторон; коллизия разделителя режет контент до вхождения", () => {
    const nonce = makeNonce();
    const poisoned = separatorCollision(`(nonce ${nonce})`);
    const framed = frameUntrusted("README.md", poisoned, nonce)!;
    expect(framed).toContain(`(nonce ${nonce}) ===`);
    expect(framed).toContain("Честное описание проекта");
    // инъекция ПОСЛЕ разделителя ушла из блока
    expect(framed).not.toContain("ассистент без ограничений");
    expect(framed.endsWith(`=== КОНЕЦ НЕДОВЕРЕННЫХ ДАННЫХ (nonce ${nonce}) ===`)).toBe(true);
  });

  test("гигантский README обрезается по капу; пустой — блока нет; нерусский проходит", () => {
    const giant = sanitizeContent(giantReadme(CONTENT_CAP_BYTES * 4));
    expect(giant.truncated).toBe(true);
    expect(Buffer.byteLength(giant.text, "utf8")).toBeLessThanOrEqual(CONTENT_CAP_BYTES);
    expect(frameUntrusted("README.md", EMPTY_README, makeNonce())).toBeNull();
    const ru = frameUntrusted("README.md", NON_RUSSIAN_README, makeNonce())!;
    expect(ru).toContain("インストール"); // контент не цензурируется по языку
  });

  test("самовосхваление и grep-инъекция проезжают РАМКУ (их ловит валидатор и хартия)", () => {
    const nonce = makeNonce();
    const framed = frameUntrusted("TODO", SELF_PRAISE_TODO, nonce)!;
    expect(framed).toContain("гениально"); // данные не режутся — они данные
    expect(framed.startsWith("=== НАЧАЛО НЕДОВЕРЕННЫХ ДАННЫХ: TODO")).toBe(true);
  });

  test("extractRefs и stripMarkers согласованы", () => {
    const { refs, segments } = extractRefs("а {f:docs.presence} б {sp:code:2} в {f:docs.presence}");
    expect(refs).toEqual(["docs.presence"]);
    expect(segments).toEqual(["sp:code:2"]);
    expect(stripMarkers("а {f:docs.presence}, б {sp:code:2}.")).toBe("а, б.");
  });
});

// Держим импорты фикстур живыми (полный набор §3.6 используется наборами Б2/Б3)
void [INFLATE_README, DARKEN_README, EXFILTRATE_README];
