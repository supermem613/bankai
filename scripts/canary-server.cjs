// Tiny http server used by .bankai/plans/node-server-self.plan.json as
// a canary for the persistent setup + wait + stop cycle. Logs READY on
// startup so a log-line readiness probe could also match.
const http = require("node:http");

const port = parseInt(process.env.PORT ?? "47391", 10);

const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain");
  res.end("hi from canary server\n");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`READY listening on http://127.0.0.1:${port}`);
});

setInterval(() => {}, 60_000);
