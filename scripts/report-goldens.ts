// report-goldens.ts — генератор эталонов MD-отчёта фикстур (В4.9, Б0/Б4):
// bun scripts/report-goldens.ts. Перезаписывает tests/fixtures/report/*.md
// выводом `renderRepoReport` на фикстурных карточках (tests/report-fixtures.ts).
// Каждый перезаписанный эталон сверяется глазами с эталоном вида и
// называется в отчёте воркера закрытым списком — генератор этого не отменяет.
// Сети и живой БД нет: фикстуры живут во временных БД.
// часовой пояс — как у `bun test` (UTC): время в приложении эталона не зависит от машины
process.env.TZ = "UTC";
import { writeFileSync } from "node:fs";
import { renderRepoReport } from "../src/report/markdown";
import { REPORT_FIXTURES, fixtureCard, goldenPath } from "../tests/report-fixtures";

for (const name of REPORT_FIXTURES) {
  const { card, close } = fixtureCard(name);
  try {
    writeFileSync(goldenPath(name), renderRepoReport(card));
    console.log(`written ${goldenPath(name)}`);
  } finally {
    close();
  }
}
