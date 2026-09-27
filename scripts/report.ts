// CLI MD-отчета: bun scripts/report.ts <org/repo> [> файл]. Тот же генератор и
// та же карточка, что у страницы и маршрута `.md`, — отчет не может разойтись с
// экраном. Сети нет: читается БД.
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { getRepoCard } from "../src/api/repos";
import { renderRepoReport } from "../src/report/markdown";

const slug = process.argv[2];
if (!slug || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(slug)) {
  console.error("usage: bun scripts/report.ts <org/repo> [> файл]");
  process.exit(2);
}
const [org, repo] = slug.split("/") as [string, string];

const db = openDb(loadConfig());
const card = getRepoCard(db, org, repo);
if (!card) {
  console.error(`репозиторий ${slug} не найден в каталоге (data/repo-health.db)`);
  db.close();
  process.exit(1);
}
// в stdout едет только сам отчёт: вывод можно перенаправить в файл
process.stdout.write(renderRepoReport(card));
db.close();
