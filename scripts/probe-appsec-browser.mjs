// Read-only SourceCraft browser probe. Connects to an already running Chrome
// DevTools endpoint and prints only request metadata; headers/cookies are never
// requested or logged.
const port = Number(process.argv[2] ?? 9333);
const targetUrl = process.argv[3] ?? "https://sourcecraft.dev/examples/vulnerable-repo";
const waitMs = Number(process.argv[4] ?? 15000);

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const target = targets.find((item) => item.type === "page");
if (!target?.webSocketDebuggerUrl) throw new Error("Chrome page target not found");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const requests = new Map();
const responses = [];

function call(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method === "Network.requestWillBeSent") {
    const { requestId, request, type } = message.params;
    requests.set(requestId, { method: request.method, url: request.url, type });
  }
  if (message.method === "Network.responseReceived") {
    const request = requests.get(message.params.requestId);
    if (request) responses.push({ ...request, status: message.params.response.status });
  }
});

await call("Network.enable");
await call("Page.enable");
await call("Runtime.enable");
await call("Page.navigate", { url: targetUrl });
await new Promise((resolve) => setTimeout(resolve, waitMs));

const page = await call("Runtime.evaluate", {
  expression: `JSON.stringify({
    title: document.title,
    location: location.href,
    textChars: (document.body?.innerText || "").length,
    links: [...document.querySelectorAll("a[href]")]
      .map(a => ({text: (a.innerText || a.getAttribute("aria-label") || "").trim(), href: a.href}))
      .filter(x => /security|безопас|scan|скан|vulnerab|уязв|sarif/i.test(x.text + " " + x.href))
      .slice(0, 100)
  })`,
  returnByValue: true,
});

const interesting = responses
  .filter(({ url, type }) =>
    type === "Document" ||
    /\/gateway\/root\/api\//i.test(url) ||
    /appsec\.sourcecraft|security|defect|finding|sarif|scan/i.test(url),
  )
  .map(({ method, url, type, status }) => {
    const parsed = new URL(url);
    return { method, status, type, url: `${parsed.origin}${parsed.pathname}` };
  })
  .filter((item, index, all) =>
    all.findIndex((other) => other.method === item.method && other.status === item.status && other.url === item.url) === index,
  );

console.log(JSON.stringify({ page: JSON.parse(page.result.value), requests: interesting }, null, 2));
ws.close();
