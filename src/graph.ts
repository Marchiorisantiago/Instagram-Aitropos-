import { readFile } from "node:fs/promises";

export class GraphError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Params = Record<string, unknown>;

export interface Config {
  token: string;
  userId?: string;
  host: string;
  version: string;
  appId?: string;
  appSecret?: string;
}

export function loadConfig(env = process.env): Config {
  const token = env.IG_ACCESS_TOKEN;
  if (!token) throw new Error("Falta IG_ACCESS_TOKEN en el entorno.");
  return {
    token,
    userId: env.IG_USER_ID || undefined,
    host: (env.IG_API_HOST || "https://graph.instagram.com").replace(/\/$/, ""),
    version: env.IG_API_VERSION || "v23.0",
    appId: env.IG_APP_ID || undefined,
    appSecret: env.IG_APP_SECRET || undefined,
  };
}

function serialize(params: Params): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out.set(k, typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return out;
}

export class Graph {
  private resolvedUserId?: string;
  constructor(public cfg: Config) {}

  /** Llama a la Graph API. El token nunca se incluye en mensajes de error. */
  async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Params = {},
    opts: { noVersion?: boolean; noToken?: boolean } = {},
  ): Promise<any> {
    const p = { ...params };
    if (!opts.noToken) p.access_token = this.cfg.token;
    const base = `${this.cfg.host}${opts.noVersion ? "" : "/" + this.cfg.version}/${path.replace(/^\//, "")}`;
    const body = serialize(p);
    const res =
      method === "GET"
        ? await fetch(`${base}?${body}`)
        : await fetch(base, {
            method,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
          });
    return this.parse(res);
  }

  /** GET a una URL absoluta de paginación (paging.next) — ya incluye el token. */
  async getUrl(url: string): Promise<any> {
    const u = new URL(url);
    const host = new URL(this.cfg.host).host;
    if (u.host !== host) throw new Error(`La URL de paginación debe ser del host ${host}.`);
    return this.parse(await fetch(url));
  }

  private async parse(res: Response): Promise<any> {
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok || json?.error) {
      const e = json?.error ?? {};
      const hint = e.code === 190 ? " (token inválido o vencido: renovalo con ig_refresh_token)" : "";
      throw new GraphError(
        `Instagram API ${res.status}: ${e.message ?? text.slice(0, 300)}${hint}`,
        res.status,
        e.code !== undefined
          ? { code: e.code, subcode: e.error_subcode, type: e.type, fbtrace_id: e.fbtrace_id, user_msg: e.error_user_msg }
          : undefined,
      );
    }
    return json;
  }

  async userId(override?: string): Promise<string> {
    if (override) return override;
    if (this.cfg.userId) return this.cfg.userId;
    if (!this.resolvedUserId) {
      const me = await this.request("GET", "me", { fields: "user_id,id" });
      this.resolvedUserId = String(me.user_id ?? me.id);
    }
    return this.resolvedUserId;
  }

  async containerStatus(id: string) {
    return this.request("GET", id, { fields: "status_code,status" });
  }

  /** Espera a que el contenedor esté FINISHED. Lanza si da ERROR/EXPIRED o se agota el tiempo. */
  async waitForContainer(id: string, timeoutSec = 300, intervalSec = 5) {
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      const s = await this.containerStatus(id);
      if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED") return s;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED")
        throw new GraphError(`El contenedor ${id} terminó en ${s.status_code}: ${s.status ?? ""}`, 400, s);
      if (Date.now() > deadline)
        throw new GraphError(
          `Timeout esperando el procesamiento del contenedor ${id} (último estado: ${s.status_code}). Podés reintentar con ig_publish_container.`,
          408,
          s,
        );
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
    }
  }

  async publishContainer(userId: string, creationId: string) {
    // Reintenta si el contenedor aún no está listo (error 9007 / subcode 2207027)
    for (let i = 0; i < 4; i++) {
      try {
        return await this.request("POST", `${userId}/media_publish`, { creation_id: creationId });
      } catch (e) {
        const d = (e as GraphError).details as any;
        if (i < 3 && d && (d.code === 9007 || d.subcode === 2207027)) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        throw e;
      }
    }
  }

  /** Sube un archivo local al contenedor con el protocolo resumable (rupload). */
  async resumableUpload(uri: string, filePath: string) {
    const data = await readFile(filePath);
    const res = await fetch(uri, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${this.cfg.token}`,
        offset: "0",
        file_size: String(data.byteLength),
      },
      body: data,
    });
    return this.parse(res);
  }
}
