// Проверка фактов AI: «CI стабилен» при доле успешных запусков ниже порога «Почините CI»
// спорит с критичной рекомендацией на той же карточке (аудит 20.10, LOG-17).
// Честный текст о плохом CI (отрицания, название показателя) отклонять нельзя.
import { describe, expect, test } from "bun:test";
import { ciStabilityClaim } from "../src/summary/validator";

const failing = [{ key: "cicd.runs", value: { weighted_success_rate: 0.73, success_rate: 0.69 } }];
const healthy = [{ key: "cicd.runs", value: { weighted_success_rate: 0.95 } }];

describe("ciStabilityClaim", () => {
  test("похвала CI при доле ниже 90% — отказ с долей с учетом свежести", () => {
    expect(ciStabilityClaim("CI/CD настроен стабильно, а пайплайн успешно проходит проверки.", failing)).toContain("73%");
    expect(ciStabilityClaim("Пайплайн надежный и быстрый.", failing)).not.toBeNull();
  });

  test("отрицания и название показателя — не похвала", () => {
    for (const t of ["CI работает нестабильно.", "Сборки не всегда успешно проходят.", "Показатель «Стабильность CI в динамике» в норме.", "CI ненадежен: часть запусков падает."]) {
      expect(ciStabilityClaim(t, failing)).toBeNull();
    }
  });

  test("похвала соседу по предложению — не похвала CI", () => {
    for (const t of [
      "Документация подробная и надежная, а CI проходит в 60% запусков.",
      "Активность стабильная, в CI успешны 60% запусков.",
      "Релизы выходят стабильно; сборки проходят в 60% случаев.",
      "Код надежный, но CI проходит в 60% запусков.",
    ]) {
      expect(ciStabilityClaim(t, failing)).toBeNull();
    }
  });

  test("настоящая похвала CI при низкой доле — по-прежнему отказ", () => {
    for (const t of [
      "CI стабилен.",
      "Сборки CI надежные.",
      "Стабильный CI с 60% успешных запусков.",
      "Сборки и тесты стабильно проходят.",
      "CI настроен и работает стабильно.",
      "CI быстрый, надежный.",
      "Документация подробная, а CI – надежный.",
    ]) {
      expect(ciStabilityClaim(t, failing)).not.toBeNull();
    }
  });

  test("доля от 90% или данных о запусках нет — проверки нет", () => {
    expect(ciStabilityClaim("CI работает стабильно.", healthy)).toBeNull();
    expect(ciStabilityClaim("CI работает стабильно.", [])).toBeNull();
  });
});
