const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const idx = trimmed.indexOf("=");
      if (idx === -1) return;
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    });
  } catch {
    // ignore missing .env
  }
}

loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const DATA_PATH = path.join(__dirname, "woldecks-data.json");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const sessions = new Map(); // sid -> { createdAt, verified: Set<string>, tokens: Map<postId, token> }

function readData() {
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { posts: [] };
    if (!Array.isArray(parsed.posts)) return { posts: [] };
    return parsed;
  } catch {
    return { posts: [] };
  }
}

function writeData(data) {
  const tmp = `${DATA_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, DATA_PATH);
}

function nowIso() {
  return new Date().toISOString();
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
  return true;
}

function notFound(res) {
  return json(res, 404, { error: "Not found" });
}

function badRequest(res, msg) {
  return json(res, 400, { error: msg || "Bad request" });
}

function unauthorized(res, msg) {
  return json(res, 401, { error: msg || "Unauthorized" });
}

function readBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req, res) {
  try {
    const raw = await readBody(req);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (e) {
    badRequest(res, "Invalid JSON");
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (!k) return;
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function sign(value) {
  const mac = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(value)
    .digest("hex");
  return `${value}.${mac}`;
}

function verifySigned(signed) {
  const idx = signed.lastIndexOf(".");
  if (idx === -1) return null;
  const value = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(value)
    .digest("hex");
  try {
    if (
      crypto.timingSafeEqual(Buffer.from(mac, "utf8"), Buffer.from(expected, "utf8"))
    ) {
      return value;
    }
  } catch {
    return null;
  }
  return null;
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push("Path=/");
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.clear) parts.push("Max-Age=0");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function getSessionId(req) {
  const cookies = parseCookies(req);
  const signed = cookies["woldecks.sid"];
  if (!signed) return null;
  return verifySigned(signed);
}

function getOrCreateSession(req, res) {
  let sid = getSessionId(req);
  if (sid && sessions.has(sid)) return { sid, session: sessions.get(sid) };

  sid = crypto.randomUUID();
  const session = { createdAt: nowIso(), verified: new Set(), tokens: new Map() };
  sessions.set(sid, session);
  setCookie(res, "woldecks.sid", sign(sid));
  return { sid, session };
}

function getAdminSession(req) {
  const cookies = parseCookies(req);
  const signed = cookies["woldecks.admin"];
  if (!signed) return null;
  const sid = verifySigned(signed);
  if (!sid) return null;
  return sessions.has(sid) ? sid : null;
}

function isAdmin(req) {
  return Boolean(getAdminSession(req));
}

function pbkdf2Hash(password, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  const iterations = 120_000;
  const keylen = 32;
  const digest = "sha256";
  const hash = crypto.pbkdf2Sync(password, salt, iterations, keylen, digest);
  return { iterations, digest, keylen, hashHex: hash.toString("hex") };
}

function makePasswordRecord(password) {
  const saltHex = crypto.randomBytes(16).toString("hex");
  const derived = pbkdf2Hash(password, saltHex);
  return {
    saltHex,
    iterations: derived.iterations,
    digest: derived.digest,
    keylen: derived.keylen,
    hashHex: derived.hashHex,
  };
}

function verifyPassword(password, record) {
  const derived = crypto.pbkdf2Sync(
    password,
    Buffer.from(record.saltHex, "hex"),
    record.iterations,
    record.keylen,
    record.digest,
  );
  try {
    return crypto.timingSafeEqual(
      Buffer.from(record.hashHex, "hex"),
      Buffer.from(derived.toString("hex"), "hex"),
    );
  } catch {
    return false;
  }
}

function serveStatic(req, res, pathname) {
  const safe = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(__dirname, safe);
  if (!filePath.startsWith(__dirname)) return notFound(res);

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const ext = path.extname(filePath).toLowerCase();
  const type =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "application/javascript; charset=utf-8"
          : "application/octet-stream";

  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname === "/api/admin/me" && req.method === "GET") {
    return json(res, 200, { admin: isAdmin(req) });
  }

  if (pathname === "/api/admin/login" && req.method === "POST") {
    return (async () => {
      const body = await readJson(req, res);
      if (body === null) return;
      const input = typeof body.password === "string" ? body.password : "";
      if (!input) return badRequest(res, "Missing field: password");
      if (input !== ADMIN_PASSWORD) return unauthorized(res, "Invalid password");

      const sid = crypto.randomUUID();
      sessions.set(sid, { createdAt: nowIso(), verified: new Set(), tokens: new Map() });
      setCookie(res, "woldecks.admin", sign(sid));
      return json(res, 200, { admin: true });
    })();
  }

  if (pathname === "/api/admin/logout" && req.method === "POST") {
    const sid = getAdminSession(req);
    if (sid) sessions.delete(sid);
    setCookie(res, "woldecks.admin", "x", { clear: true });
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/posts" && req.method === "GET") {
    const data = readData();
    const posts = [...data.posts]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((p) => ({
        id: p.id,
        title: p.title,
        author: p.author,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt || null,
      }));
    return json(res, 200, { posts });
  }

  if (pathname === "/api/posts" && req.method === "POST") {
    return (async () => {
      const body = await readJson(req, res);
      if (body === null) return;
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const author = typeof body.author === "string" ? body.author.trim() : "";
      const content = typeof body.content === "string" ? body.content.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!title || !author || !content || !password) {
        return badRequest(res, "Missing fields");
      }

      const data = readData();
      const post = {
        id: crypto.randomUUID(),
        title,
        author,
        content,
        password: makePasswordRecord(password),
        createdAt: nowIso(),
        updatedAt: null,
      };
      data.posts.unshift(post);
      writeData(data);
      return json(res, 201, { id: post.id });
    })();
  }

  const postIdMatch = pathname.match(/^\/api\/posts\/([^/]+)$/);
  if (postIdMatch && req.method === "GET") {
    if (!isAdmin(req)) return unauthorized(res, "Admin only");
    const id = postIdMatch[1];
    const data = readData();
    const post = data.posts.find((p) => p.id === id);
    if (!post) return notFound(res);
    return json(res, 200, {
      post: {
        id: post.id,
        title: post.title,
        author: post.author,
        content: post.content,
        createdAt: post.createdAt,
        updatedAt: post.updatedAt || null,
      },
    });
  }

  const viewMatch = pathname.match(/^\/api\/posts\/([^/]+)\/view$/);
  if (viewMatch && req.method === "POST") {
    return (async () => {
      if (isAdmin(req)) {
        req.url = `/api/posts/${viewMatch[1]}`;
        return route(req, res);
      }
      const body = await readJson(req, res);
      if (body === null) return;
      const password = typeof body.password === "string" ? body.password : "";
      if (!password) return unauthorized(res, "Password required");

      const id = viewMatch[1];
      const data = readData();
      const post = data.posts.find((p) => p.id === id);
      if (!post) return notFound(res);
      if (!verifyPassword(password, post.password)) return unauthorized(res, "Invalid password");

      const { session } = getOrCreateSession(req, res);
      session.verified.add(id);
      const viewToken = crypto.randomUUID();
      session.tokens.set(id, { token: viewToken, createdAt: Date.now() });

      return json(res, 200, {
        post: {
          id: post.id,
          title: post.title,
          author: post.author,
          content: post.content,
          createdAt: post.createdAt,
          updatedAt: post.updatedAt || null,
        },
        viewToken,
      });
    })();
  }

  if (postIdMatch && req.method === "PUT") {
    return (async () => {
      const id = postIdMatch[1];
      const body = await readJson(req, res);
      if (body === null) return;

      const title = typeof body.title === "string" ? body.title.trim() : "";
      const content = typeof body.content === "string" ? body.content.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const viewToken = typeof body.viewToken === "string" ? body.viewToken : "";
      if (!title || !content) return badRequest(res, "Missing fields");

      const data = readData();
      const idx = data.posts.findIndex((p) => p.id === id);
      if (idx === -1) return notFound(res);

      if (!isAdmin(req)) {
        const sid = getSessionId(req);
        const session = sid && sessions.has(sid) ? sessions.get(sid) : null;
        const verified = session ? session.verified.has(id) : false;
        const tokenOk =
          session && session.tokens.has(id)
            ? session.tokens.get(id).token === viewToken
            : false;
        if (!verified && !tokenOk) {
          if (!password) return unauthorized(res, "Password required");
          if (!verifyPassword(password, data.posts[idx].password)) {
            return unauthorized(res, "Invalid password");
          }
          const { session: ensured } = getOrCreateSession(req, res);
          ensured.verified.add(id);
          const newToken = crypto.randomUUID();
          ensured.tokens.set(id, { token: newToken, createdAt: Date.now() });
        }
      }

      data.posts[idx].title = title;
      data.posts[idx].content = content;
      data.posts[idx].updatedAt = nowIso();
      writeData(data);
      return json(res, 200, { ok: true });
    })();
  }

  if (postIdMatch && req.method === "DELETE") {
    return (async () => {
      const id = postIdMatch[1];
      const body = await readJson(req, res);
      if (body === null) return;
      const password = typeof body.password === "string" ? body.password : "";
      const viewToken = typeof body.viewToken === "string" ? body.viewToken : "";

      const data = readData();
      const idx = data.posts.findIndex((p) => p.id === id);
      if (idx === -1) return notFound(res);

      if (!isAdmin(req)) {
        const sid = getSessionId(req);
        const session = sid && sessions.has(sid) ? sessions.get(sid) : null;
        const verified = session ? session.verified.has(id) : false;
        const tokenOk =
          session && session.tokens.has(id)
            ? session.tokens.get(id).token === viewToken
            : false;
        if (!verified && !tokenOk) {
          if (!password) return unauthorized(res, "Password required");
          if (!verifyPassword(password, data.posts[idx].password)) {
            return unauthorized(res, "Invalid password");
          }
          const { session: ensured } = getOrCreateSession(req, res);
          ensured.verified.add(id);
          const newToken = crypto.randomUUID();
          ensured.tokens.set(id, { token: newToken, createdAt: Date.now() });
        }
      }

      data.posts.splice(idx, 1);
      writeData(data);
      return json(res, 200, { ok: true });
    })();
  }

  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const handled = route(req, res);
  if (handled !== null && handled !== undefined) return;
  const served = serveStatic(req, res, url.pathname);
  if (served) return;
  // SPA fallback
  const ok = serveStatic(req, res, "/index.html");
  if (!ok) notFound(res);
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_PATH}`);
  console.log(
    `Admin password: ${process.env.ADMIN_PASSWORD ? "(from env)" : "admin1234 (default)"}`
  );
});
