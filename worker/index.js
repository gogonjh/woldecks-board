const corsHeaders = (origin) => {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
};

const json = (status, body, extraHeaders = {}) => {
  const payload = JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
};

const badRequest = (msg) => json(400, { error: msg || "Bad request" });
const unauthorized = (msg) => json(401, { error: msg || "Unauthorized" });
const notFound = () => json(404, { error: "Not found" });

const textEncoder = new TextEncoder();

const bytesToHex = (bytes) =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const hexToBytes = (hex) => {
  if (!hex) return new Uint8Array();
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const safeEqualHex = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

const pbkdf2Hash = async (password, saltHex, iterations, keylen, digest) => {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: digest,
      salt: hexToBytes(saltHex),
      iterations,
    },
    key,
    keylen * 8,
  );
  return bytesToHex(new Uint8Array(bits));
};

const makePasswordRecord = async (password) => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = bytesToHex(salt);
  const iterations = 100000;
  const keylen = 32;
  const digest = "SHA-256";
  const hashHex = await pbkdf2Hash(password, saltHex, iterations, keylen, digest);
  return {
    pw_salt_hex: saltHex,
    pw_iterations: iterations,
    pw_digest: "sha256",
    pw_keylen: keylen,
    pw_hash_hex: hashHex,
  };
};

const verifyPassword = async (password, record) => {
  const digest = record.pw_digest === "sha256" ? "SHA-256" : record.pw_digest;
  const hashHex = await pbkdf2Hash(
    password,
    record.pw_salt_hex,
    record.pw_iterations,
    record.pw_keylen,
    digest,
  );
  return safeEqualHex(hashHex, record.pw_hash_hex);
};

const sha256Hex = async (input) => {
  const bytes = textEncoder.encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
};

const parseCookies = (header) => {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
};

const makeToken = async (pepper) => {
  const token = crypto.randomUUID();
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await sha256Hex(`${token}:${salt}:${pepper}`);
  return { token, salt, hash };
};

const splitToken = (raw) => {
  if (!raw) return null;
  const idx = raw.lastIndexOf(".");
  if (idx === -1) return null;
  return { token: raw.slice(0, idx), salt: raw.slice(idx + 1) };
};

const readJson = async (request) => {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const supabaseRequest = async (env, path, options = {}) => {
  const url = `${env.SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...options.headers,
  };
  return fetch(url, { ...options, headers });
};

const getAllowedOrigin = (request, env) => {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  // Temporary: echo origin to avoid CORS blocking.
  // You can re-tighten this once the environment is stable.
  return origin;
};

const handleOptions = (request, env) => {
  const origin = getAllowedOrigin(request, env);
  if (!origin) return new Response(null, { status: 204 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
};

const adminSessionFromCookie = async (request, env) => {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const raw = cookies["woldecks.admin"];
  const tokenParts = splitToken(raw);
  if (!tokenParts) return null;
  const tokenHash = await sha256Hex(
    `${tokenParts.token}:${tokenParts.salt}:${env.TOKEN_PEPPER}`,
  );
  const qs = new URLSearchParams({
    select: "id",
    token_hash: `eq.${tokenHash}`,
    token_salt: `eq.${tokenParts.salt}`,
    expires_at: `gt.${new Date().toISOString()}`,
    limit: "1",
  });
  const res = await supabaseRequest(env, `admin_sessions?${qs.toString()}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.length > 0 ? data[0] : null;
};

const isAdmin = async (request, env) => Boolean(await adminSessionFromCookie(request, env));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = getAllowedOrigin(request, env);

    if (request.method === "OPTIONS") {
      return handleOptions(request, env);
    }

    const path = url.pathname;
    const send = (status, body, extraHeaders = {}) =>
      json(status, body, { ...extraHeaders, ...(origin ? corsHeaders(origin) : {}) });

    try {

    if (path === "/api/admin/me" && request.method === "GET") {
      const admin = await isAdmin(request, env);
      return send(200, { admin });
    }

    if (path === "/api/admin/login" && request.method === "POST") {
      const body = await readJson(request);
      if (!body) return send(400, { error: "Invalid JSON" });
      const input = typeof body.password === "string" ? body.password : "";
      if (!input) return send(400, { error: "Missing field: password" });
      if (input !== env.ADMIN_PASSWORD) return send(401, { error: "Invalid password" });

      const tokenData = await makeToken(env.TOKEN_PEPPER);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const insertRes = await supabaseRequest(env, "admin_sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          token_hash: tokenData.hash,
          token_salt: tokenData.salt,
          expires_at: expiresAt,
        }),
      });
      if (!insertRes.ok) return send(500, { error: "Failed to create session" });

      const cookie = [
        `woldecks.admin=${encodeURIComponent(`${tokenData.token}.${tokenData.salt}`)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=None",
        "Secure",
        "Max-Age=86400",
      ].join("; ");

      return send(200, { admin: true }, { "Set-Cookie": cookie });
    }

    if (path === "/api/admin/logout" && request.method === "POST") {
      const cookies = parseCookies(request.headers.get("Cookie"));
      const raw = cookies["woldecks.admin"];
      if (raw) {
        const tokenParts = splitToken(raw);
        if (tokenParts) {
          const tokenHash = await sha256Hex(
            `${tokenParts.token}:${tokenParts.salt}:${env.TOKEN_PEPPER}`,
          );
          const qs = new URLSearchParams({
            token_hash: `eq.${tokenHash}`,
            token_salt: `eq.${tokenParts.salt}`,
          });
          await supabaseRequest(env, `admin_sessions?${qs.toString()}`, {
            method: "DELETE",
          });
        }
      }

      const cookie = [
        "woldecks.admin=x",
        "Path=/",
        "HttpOnly",
        "SameSite=None",
        "Secure",
        "Max-Age=0",
      ].join("; ");

      return send(200, { ok: true }, { "Set-Cookie": cookie });
    }

    if (path === "/api/posts" && request.method === "GET") {
      const qs = new URLSearchParams({
        select: "id,title,author,created_at,updated_at",
        order: "created_at.desc",
      });
      const res = await supabaseRequest(env, `posts?${qs.toString()}`);
      if (!res.ok) {
        const detail = await res.text();
        return send(500, { error: "Failed to load posts", detail });
      }
      const posts = await res.json();
      return send(200, {
        posts: posts.map((p) => ({
          id: p.id,
          title: p.title,
          author: p.author,
          createdAt: p.created_at,
          updatedAt: p.updated_at,
        })),
      });
    }

    if (path === "/api/posts" && request.method === "POST") {
      const body = await readJson(request);
      if (!body) return send(400, { error: "Invalid JSON" });
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const author = typeof body.author === "string" ? body.author.trim() : "";
      const content = typeof body.content === "string" ? body.content.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!title || !author || !content || !password) {
        return send(400, { error: "Missing fields" });
      }

      const passwordRecord = await makePasswordRecord(password);
      const payload = {
        title,
        author,
        content,
        ...passwordRecord,
      };
      const res = await supabaseRequest(env, "posts", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const detail = await res.text();
        return send(500, { error: "Failed to create post", detail });
      }
      const created = await res.json();
      return send(201, { id: created[0]?.id });
    }

    const postMatch = path.match(/^\/api\/posts\/([^/]+)$/);
    if (postMatch && request.method === "GET") {
      if (!(await isAdmin(request, env))) return send(401, { error: "Admin only" });
      const id = postMatch[1];
      const qs = new URLSearchParams({
        select: "id,title,author,content,created_at,updated_at",
        id: `eq.${id}`,
        limit: "1",
      });
      const res = await supabaseRequest(env, `posts?${qs.toString()}`);
      if (!res.ok) {
        const detail = await res.text();
        return send(500, { error: "Failed to load post", detail });
      }
      const data = await res.json();
      if (data.length === 0) return send(404, { error: "Not found" });
      const post = data[0];
      return send(200, {
        post: {
          id: post.id,
          title: post.title,
          author: post.author,
          content: post.content,
          createdAt: post.created_at,
          updatedAt: post.updated_at,
        },
      });
    }

    const viewMatch = path.match(/^\/api\/posts\/([^/]+)\/view$/);
    if (viewMatch && request.method === "POST") {
      if (await isAdmin(request, env)) {
        const id = viewMatch[1];
        const qs = new URLSearchParams({
          select: "id,title,author,content,created_at,updated_at",
          id: `eq.${id}`,
          limit: "1",
        });
        const res = await supabaseRequest(env, `posts?${qs.toString()}`);
        if (!res.ok) {
          const detail = await res.text();
          return send(500, { error: "Failed to load post", detail });
        }
        const data = await res.json();
        if (data.length === 0) return send(404, { error: "Not found" });
        const post = data[0];
        return send(200, {
          post: {
            id: post.id,
            title: post.title,
            author: post.author,
            content: post.content,
            createdAt: post.created_at,
            updatedAt: post.updated_at,
          },
        });
      }
      const body = await readJson(request);
      if (!body) return send(400, { error: "Invalid JSON" });
      const password = typeof body.password === "string" ? body.password : "";
      if (!password) return send(401, { error: "Password required" });

      const id = viewMatch[1];
      const qs = new URLSearchParams({
        select: "id,title,author,content,created_at,updated_at,pw_salt_hex,pw_iterations,pw_digest,pw_keylen,pw_hash_hex",
        id: `eq.${id}`,
        limit: "1",
      });
      const res = await supabaseRequest(env, `posts?${qs.toString()}`);
      if (!res.ok) {
        const detail = await res.text();
        return send(500, { error: "Failed to load post", detail });
      }
      const data = await res.json();
      if (data.length === 0) return send(404, { error: "Not found" });
      const post = data[0];
      const ok = await verifyPassword(password, post);
      if (!ok) return send(401, { error: "Invalid password" });

      const tokenData = await makeToken(env.TOKEN_PEPPER);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const insertRes = await supabaseRequest(env, "view_tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          post_id: id,
          token_hash: tokenData.hash,
          token_salt: tokenData.salt,
          expires_at: expiresAt,
        }),
      });
      if (!insertRes.ok) {
        const detail = await insertRes.text();
        return send(500, { error: "Failed to issue token", detail });
      }

      return send(200, {
        post: {
          id: post.id,
          title: post.title,
          author: post.author,
          content: post.content,
          createdAt: post.created_at,
          updatedAt: post.updated_at,
        },
        viewToken: `${tokenData.token}.${tokenData.salt}`,
      });
    }

    if (postMatch && request.method === "PUT") {
      const id = postMatch[1];
      const body = await readJson(request);
      if (!body) return send(400, { error: "Invalid JSON" });

      const title = typeof body.title === "string" ? body.title.trim() : "";
      const content = typeof body.content === "string" ? body.content.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const viewToken = typeof body.viewToken === "string" ? body.viewToken : "";
      if (!title || !content) return send(400, { error: "Missing fields" });

      const isAdminUser = await isAdmin(request, env);
      if (!isAdminUser) {
        let authorized = false;
        const tokenParts = splitToken(viewToken);
        if (tokenParts) {
          const tokenHash = await sha256Hex(
            `${tokenParts.token}:${tokenParts.salt}:${env.TOKEN_PEPPER}`,
          );
          const qs = new URLSearchParams({
            select: "id",
            post_id: `eq.${id}`,
            token_hash: `eq.${tokenHash}`,
            token_salt: `eq.${tokenParts.salt}`,
            expires_at: `gt.${new Date().toISOString()}`,
            limit: "1",
          });
          const res = await supabaseRequest(env, `view_tokens?${qs.toString()}`);
          if (res.ok) {
            const rows = await res.json();
            authorized = rows.length > 0;
          }
        }

        if (!authorized) {
          if (!password) return send(401, { error: "Password required" });
          const qs = new URLSearchParams({
            select: "pw_salt_hex,pw_iterations,pw_digest,pw_keylen,pw_hash_hex",
            id: `eq.${id}`,
            limit: "1",
          });
          const res = await supabaseRequest(env, `posts?${qs.toString()}`);
          if (!res.ok) {
            const detail = await res.text();
            return send(500, { error: "Failed to verify", detail });
          }
          const data = await res.json();
          if (data.length === 0) return send(404, { error: "Not found" });
          const ok = await verifyPassword(password, data[0]);
          if (!ok) return send(401, { error: "Invalid password" });
        }
      }

      const updateRes = await supabaseRequest(env, `posts?id=eq.${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({ title, content }),
      });
      if (!updateRes.ok) {
        const detail = await updateRes.text();
        return send(500, { error: "Failed to update", detail });
      }
      return send(200, { ok: true });
    }

    if (postMatch && request.method === "DELETE") {
      const id = postMatch[1];
      const body = await readJson(request);
      if (!body) return send(400, { error: "Invalid JSON" });

      const password = typeof body.password === "string" ? body.password : "";
      const viewToken = typeof body.viewToken === "string" ? body.viewToken : "";

      const isAdminUser = await isAdmin(request, env);
      if (!isAdminUser) {
        let authorized = false;
        const tokenParts = splitToken(viewToken);
        if (tokenParts) {
          const tokenHash = await sha256Hex(
            `${tokenParts.token}:${tokenParts.salt}:${env.TOKEN_PEPPER}`,
          );
          const qs = new URLSearchParams({
            select: "id",
            post_id: `eq.${id}`,
            token_hash: `eq.${tokenHash}`,
            token_salt: `eq.${tokenParts.salt}`,
            expires_at: `gt.${new Date().toISOString()}`,
            limit: "1",
          });
          const res = await supabaseRequest(env, `view_tokens?${qs.toString()}`);
          if (res.ok) {
            const rows = await res.json();
            authorized = rows.length > 0;
          }
        }

        if (!authorized) {
          if (!password) return send(401, { error: "Password required" });
          const qs = new URLSearchParams({
            select: "pw_salt_hex,pw_iterations,pw_digest,pw_keylen,pw_hash_hex",
            id: `eq.${id}`,
            limit: "1",
          });
          const res = await supabaseRequest(env, `posts?${qs.toString()}`);
          if (!res.ok) {
            const detail = await res.text();
            return send(500, { error: "Failed to verify", detail });
          }
          const data = await res.json();
          if (data.length === 0) return send(404, { error: "Not found" });
          const ok = await verifyPassword(password, data[0]);
          if (!ok) return send(401, { error: "Invalid password" });
        }
      }

      const delRes = await supabaseRequest(env, `posts?id=eq.${id}`, {
        method: "DELETE",
      });
      if (!delRes.ok) {
        const detail = await delRes.text();
        return send(500, { error: "Failed to delete", detail });
      }
      return send(200, { ok: true });
    }

      return send(404, { error: "Not found" });
    } catch (err) {
      return send(500, { error: "Worker error", detail: String(err?.message || err) });
    }
  },
};
