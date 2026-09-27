// CLI PDF-отчета: тот же генератор и та же карточка, что у маршрута `.pdf`, —
// чтобы проверять отчет по отрисованному результату.
//
//   DATA_DIR=<копия БД> bun scripts/report-pdf.ts <org/repo> <out.pdf> [--viewer=anon|full]
//   bun scripts/report-pdf.ts --fixture=<anon|full|grant-ci|null|never> <out.pdf>
//
// Сети нет: читается БД (только копия живой — `VACUUM INTO` с readonly-хендла)
// или фикстура во временной БД. DATA_DIR обязан быть задан явно для живого
// репозитория. `--viewer=full` — зритель с доступом к CI/CD и Безопасности
// (без сети: доступ подставляется, как в тестах), по умолчанию — аноним.
// В stdout — путь файла; PNG страниц снимает PyMuPDF (scripts/report-png.py).
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { getRepoCard } from "../src/api/repos";
import { renderRepoPdf } from "../src/report/pdf";
import { renderRepoReport } from "../src/report/markdown";
import { REPORT_FIXTURES, fixtureCard, type ReportFixture } from "../tests/report-fixtures";

const args = process.argv.slice(2);
const fixture = args.find((a) => a.startsWith("--fixture="))?.slice("--fixture=".length);
const viewer = args.find((a) => a.startsWith("--viewer="))?.slice("--viewer=".length) ?? "anon";
const positional = args.filter((a) => !a.startsWith("--"));

async function main(): Promise<void> {
  if (fixture) {
    const out = positional[0];
    if (!REPORT_FIXTURES.includes(fixture as ReportFixture) || !out) {
      console.error(`usage: bun scripts/report-pdf.ts --fixture=<${REPORT_FIXTURES.join("|")}> <out.pdf>`);
      process.exit(2);
    }
    const { card, close } = fixtureCard(fixture as ReportFixture);
    try {
      writeFileSync(out, await renderRepoPdf(card));
      writeFileSync(out.replace(/\.pdf$/, ".md"), renderRepoReport(card));
    } finally {
      close();
    }
    console.log(out);
    return;
  }
  const [slug, out] = positional;
  if (!slug || !out || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(slug)) {
    console.error("usage: DATA_DIR=<копия БД> bun scripts/report-pdf.ts <org/repo> <out.pdf> [--viewer=anon|full]");
    process.exit(2);
  }
  if (!process.env.DATA_DIR) {
    console.error("DATA_DIR не задан: живой отчет строится только по явной копии БД");
    process.exit(2);
  }
  const [org, repo] = slug.split("/") as [string, string];
  const db = openDb(loadConfig());
  try {
    const card =
      viewer === "full"
        ? getRepoCard(db, org, repo, { access: { cicd: "granted", appsec: "granted", repo: "granted" }, viewerAuth: "pat" })
        : getRepoCard(db, org, repo);
    if (!card) {
      console.error(`репозиторий ${slug} не найден в каталоге`);
      process.exit(1);
    }
    writeFileSync(out, await renderRepoPdf(card));
    writeFileSync(out.replace(/\.pdf$/, ".md"), renderRepoReport(card));
    console.log(out);
  } finally {
    db.close();
  }
}

await main();
