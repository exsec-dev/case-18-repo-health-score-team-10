// Проверка фактов AI: «нет CODEOWNERS» при docs.presence.codeowners = true. 20.10 разбор
// документации своего репо в 2 из 3 прогонов называл отсутствующими файлы, которые
// есть, и валидатор это пропускал. Тексты — из тех прогонов.
import { describe, expect, test } from "bun:test";
import { docsAbsenceClaim, validateOutput } from "../src/summary/validator";

const all = [{ key: "docs.presence", value: { readme: true, license: true, contributing: true, codeowners: true, content_checked: true } }];
const noLicense = [{ key: "docs.presence", value: { readme: true, license: false, contributing: true, codeowners: true, content_checked: true } }];

describe("docsAbsenceClaim", () => {
  test("отсутствие файла, который есть, — отказ с именами файлов", () => {
    expect(docsAbsenceClaim("Из обязательных файлов отсутствуют CONTRIBUTING и CODEOWNERS.", all)).toContain("CONTRIBUTING, CODEOWNERS");
    expect(docsAbsenceClaim("Из обязательных файлов проекта отсутствуют только LICENSE и CONTRIBUTING, хотя флаги проверки показывают, что они есть.", all)).toContain("LICENSE, CONTRIBUTING");
    expect(docsAbsenceClaim("Из обязательных файлов проекта отсутствуют только правила вклада и карта владельцев файлов.", all)).toContain("CONTRIBUTING, CODEOWNERS");
    expect(docsAbsenceClaim("Документ живой, но авторам не хватает CONTRIBUTING и CODEOWNERS.", all)).toContain("CONTRIBUTING, CODEOWNERS");
  });

  test("честный текст — не отказ", () => {
    for (const [t, facts] of [
      ["Из обязательных файлов присутствуют все четыре: README, LICENSE, CONTRIBUTING и CODEOWNERS.", all],
      ["Пробелов нет: README, LICENSE, CONTRIBUTING и CODEOWNERS на месте.", all],
      ["Из обязательных файлов нет только LICENSE.", noLicense],
      ["Нет LICENSE, а CONTRIBUTING и CODEOWNERS на месте.", noLicense],
      ["README не содержит раздела о правилах вклада.", all],
    ] as const) {
      expect(docsAbsenceClaim(t, facts as never)).toBeNull();
    }
  });

  test("без факта о файлах — проверки нет", () => {
    expect(docsAbsenceClaim("Нет CODEOWNERS.", [])).toBeNull();
  });

  test("validateOutput отклоняет разбор документации с выдуманным пробелом", () => {
    const facts = [...all, { key: "docs.readme", value: { bytes: 35995, sections: 18, flags: { install: true, build: true, test: true } } }];
    const v = validateOutput({
      role: "documentation",
      text: "README описывает сервис и охватывает установку, сборку и тесты {f:docs.readme}. Из обязательных файлов отсутствуют CONTRIBUTING и CODEOWNERS {f:docs.presence}. Это живой документ с конкретными шагами {f:docs.readme}.",
      facts,
      segments: [],
    });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toContain("CODEOWNERS");
  });
});
