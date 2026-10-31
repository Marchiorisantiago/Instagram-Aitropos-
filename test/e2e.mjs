// Prueba end-to-end con una Graph API simulada (no toca Instagram real).
import http from "node:http";
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const calls = [];
let polls = 0;
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const body = Buffer.concat(chunks);
    const form = Object.fromEntries(new URLSearchParams(body.toString()));
    calls.push({ m: req.method, p: u.pathname, q: Object.fromEntries(u.searchParams), form, h: req.headers, len: body.length });
    const j = (o, s = 200) => (res.writeHead(s, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
    const p = u.pathname;
    if (p === "/v23.0/me") return j({ user_id: "IG1", id: "IG1" });
    if (p === "/v23.0/IG1/media" && req.method === "POST")
      return j(form.upload_type ? { id: "C2", uri: `http://localhost:${srv.address().port}/rupload/C2` } : { id: "C1" });
    if (p === "/rupload/C2") return j({ success: true });
    if (p.match(/^\/v23.0\/C\d$/)) return j({ status_code: ++polls < 2 ? "IN_PROGRESS" : "FINISHED" });
    if (p === "/v23.0/IG1/media_publish") return j({ id: "M_" + form.creation_id });
    if (p.startsWith("/v23.0/M_")) return j({ id: p.slice(7), permalink: "https://instagram.com/reel/abc", media_type: "VIDEO", media_product_type: "REELS" });
    if (p === "/v23.0/BAD") return j({ error: { message: "Invalid token", code: 190 } }, 400);
    j({ error: { message: "unhandled " + p } }, 404);
  });
}).listen(0);
await new Promise((r) => srv.once("listening", r));

writeFileSync("/tmp/claude-0/test.mp4", Buffer.alloc(2048, 1));
const t = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, IG_ACCESS_TOKEN: "SECRET_TOKEN", IG_API_HOST: `http://localhost:${srv.address().port}` },
});
const c = new Client({ name: "t", version: "1" });
await c.connect(t);
const tools = (await c.listTools()).tools;
console.log("tools:", tools.length);

const call = async (name, args) => (await c.callTool({ name, arguments: args })).content[0].text;
console.log("REEL url ->", await call("ig_publish_reel", { video_url: "https://x.com/v.mp4", caption: "hola", share_to_feed: true, collaborators: ["a"], wait_seconds: 20 }));
const create = calls.find((x) => x.p === "/v23.0/IG1/media");
console.log("container params:", create.form);
polls = 0;
console.log("REEL file ->", await call("ig_publish_reel", { file_path: "/tmp/claude-0/test.mp4", caption: "local", wait_seconds: 20 }));
const up = calls.find((x) => x.p === "/rupload/C2");
console.log("rupload headers:", { auth: up.h.authorization, offset: up.h.offset, file_size: up.h.file_size, bytes: up.len });
console.log("publish=false ->", await call("ig_publish_reel", { video_url: "https://x.com/v.mp4", publish: false }));
const bad = await c.callTool({ name: "ig_graph_request", arguments: { path: "BAD" } });
console.log("error ->", bad.isError, bad.content[0].text);
console.log("token leaked in errors?", bad.content[0].text.includes("SECRET_TOKEN"));
await c.close(); srv.close();
