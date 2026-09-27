// Блок Caddy «запрос по IP стенда». Caddy локально не запускается – синтаксис
// проверяет `caddy validate` шагом выкладки. Здесь – только сцепка файлов, которую
// validate не видит: заглушка «IP не задан» одна и та же в compose и Caddyfile (иначе
// пустой STAND_IP в .env дал бы сайт `http://` — перехват ВСЕГО порта 80), и блок IP
// стоит вне сайта основного адреса.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const caddy = readFileSync("deploy/Caddyfile", "utf8");
const compose = readFileSync("deploy/compose.yaml", "utf8");

describe("Т2-Е: переадресация http://IP стенда", () => {
  test("заглушка пустого STAND_IP — одна, в зарезервированной зоне .invalid", () => {
    const inCaddy = /^http:\/\/\{\$STAND_IP:([^}]+)\} \{$/m.exec(caddy)?.[1];
    const inCompose = /^\s+STAND_IP: \$\{STAND_IP:-([^}]+)\}$/m.exec(compose)?.[1];
    expect(inCaddy).toBeDefined();
    expect(inCaddy).toBe(inCompose);
    expect(inCaddy!.endsWith(".invalid")).toBe(true);
  });

  test("блок IP — отдельный HTTP-сайт до сайта основного адреса, переадресация постоянная на CANONICAL_HOST", () => {
    const ipAt = caddy.indexOf("http://{$STAND_IP");
    const siteAt = caddy.indexOf("{$SITE_ADDRESS} {");
    expect(ipAt).toBeGreaterThan(-1);
    expect(ipAt).toBeLessThan(siteAt);
    const block = caddy.slice(ipAt, siteAt);
    expect(block).toContain("redir https://{$CANONICAL_HOST}{uri} permanent");
  });
});
