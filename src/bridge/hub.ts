/**
 * The local bridge between MCP processes and the Figma plugin.
 *
 * The plugin connects to one fixed port. The first Loupe process to bind it
 * becomes the hub; any later process (a second Claude session, another
 * editor) connects to the hub as a peer and has its requests forwarded. If the
 * hub exits, peers race to take over the port and the plugin reconnects on
 * its own, so sessions can come and go in any order.
 *
 * Security: the socket only listens on loopback. Browser pages can still
 * reach loopback, so a connection that carries an Origin header must come
 * from Figma (the plugin iframe has origin `null` on desktop, figma.com on
 * web) and may only register as a plugin; connections without an Origin
 * (Node processes) may only register as peers. Every request is read-only.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  type AnyMsg,
  type HelloPlugin,
  type Method,
  type MethodMap,
  type PluginInfo,
  type RequestMsg,
  type ResponseMsg,
} from "../shared/protocol";

export const SERVER_VERSION = "0.1.0";

const TIMEOUTS: Partial<Record<Method, number>> = { snapshot: 180_000, export: 180_000, find: 120_000, tokens: 60_000 };
const DEFAULT_TIMEOUT = 60_000;
const MAX_PAYLOAD = 512 * 1024 * 1024;

export function allowedOrigin(origin: string | undefined): "plugin" | "peer" | false {
  if (origin === undefined) return "peer";
  if (origin === "null") return "plugin";
  try {
    const u = new URL(origin);
    if (u.protocol === "https:" && (u.hostname === "figma.com" || u.hostname.endsWith(".figma.com"))) return "plugin";
  } catch {
    /* malformed */
  }
  return false;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Hub: the plugin connection the request went to. */
  conn?: string;
}

interface PluginConn {
  ws: WebSocket;
  info: PluginInfo;
  alive: boolean;
}

export interface BridgeOptions {
  port?: number;
  host?: string;
  log?: (msg: string) => void;
}

export class Bridge {
  readonly port: number;
  private readonly host: string;
  private readonly log: (msg: string) => void;
  private role: "hub" | "peer" | "starting" = "starting";
  private wss?: WebSocketServer;
  private hubSocket?: WebSocket;
  private readonly plugins = new Map<string, PluginConn>();
  private readonly peers = new Set<WebSocket>();
  private peerPlugins: PluginInfo[] = [];
  private readonly pending = new Map<string, Pending>();
  /** Hub: forwarded request id → the peer socket and its own id. */
  private readonly forwarded = new Map<string, { ws: WebSocket; id: string; conn: string }>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;
  private starting?: Promise<void>;
  private readonly waiters = new Set<() => void>();

  constructor(opts: BridgeOptions = {}) {
    this.port = opts.port ?? Number(process.env.LOUPE_PORT ?? DEFAULT_PORT);
    this.host = opts.host ?? "127.0.0.1";
    this.log = opts.log ?? (() => {});
  }

  get mode(): "hub" | "peer" | "starting" {
    return this.role;
  }

  /** Become the hub or a peer. Idempotent while connected. */
  start(): Promise<void> {
    if (this.role === "hub" || (this.role === "peer" && this.hubSocket?.readyState === WebSocket.OPEN)) return Promise.resolve();
    this.starting ??= this.elect().finally(() => (this.starting = undefined));
    return this.starting;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Loupe is shutting down"));
    }
    this.pending.clear();
    this.hubSocket?.close();
    for (const c of this.plugins.values()) c.ws.terminate();
    for (const p of this.peers) p.terminate();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
  }

  /** Connected plugins (one per open Figma file), most recently active first. */
  list(): PluginInfo[] {
    const all = this.role === "hub" ? [...this.plugins.values()].map((p) => p.info) : this.peerPlugins;
    return [...all].sort((a, b) => b.activeAt - a.activeAt);
  }

  /** Wait until at least one plugin is connected (or the timeout passes). */
  async waitForPlugin(ms: number): Promise<boolean> {
    if (this.list().length) return true;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve(this.list().length > 0);
      };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  /** Pick the plugin for a request: explicit file key/name/conn, else the most recently active. */
  pick(target?: string): PluginInfo {
    const list = this.list();
    if (!list.length) {
      throw new Error(
        "No Figma file is connected. Open the file in Figma (desktop app or browser) and run Plugins → Development → Loupe; keep its window open.",
      );
    }
    if (!target) return list[0]!;
    const t = target.toLowerCase();
    const hit =
      list.find((p) => p.conn === target || p.fileKey === target) ??
      list.find((p) => p.fileName.toLowerCase() === t) ??
      list.find((p) => p.fileName.toLowerCase().includes(t));
    if (hit) return hit;
    // The plugin cannot always see its file key; with a single file open, use it.
    if (list.length === 1 && !list[0]!.fileKey) return list[0]!;
    throw new Error(`No connected Figma file matches "${target}". Connected: ${list.map((p) => `"${p.fileName}"`).join(", ")}`);
  }

  async request<M extends Method>(method: M, params: MethodMap[M]["params"], target?: string): Promise<MethodMap[M]["result"]> {
    if (this.role === "starting") await this.start();
    const timeout = TIMEOUTS[method] ?? DEFAULT_TIMEOUT;
    if (this.role === "hub") {
      const plugin = this.pick(target);
      const conn = this.plugins.get(plugin.conn);
      if (!conn) throw new Error("The Figma plugin disconnected; run it again.");
      return (await this.send(conn.ws, { t: "req", id: randomUUID(), method, params }, timeout, plugin.conn)) as MethodMap[M]["result"];
    }
    if (!this.hubSocket || this.hubSocket.readyState !== WebSocket.OPEN) {
      await this.start();
      // start() may have made this process the hub (the old hub exited).
      if (this.mode === "hub") return this.request(method, params, target);
    }
    const ws = this.hubSocket!;
    return (await this.send(ws, { t: "req", id: randomUUID(), method, params, target }, timeout + 5_000)) as MethodMap[M]["result"];
  }

  /* ---------------------------------------------------------------- */

  private send(ws: WebSocket, msg: RequestMsg, timeout: number, conn?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error(`Figma did not answer "${msg.method}" within ${Math.round(timeout / 1000)}s. Large selections take longer; try a smaller frame or a lower depth.`));
      }, timeout);
      this.pending.set(msg.id, { resolve, reject, timer, conn });
      ws.send(JSON.stringify(msg), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(msg.id);
          reject(err);
        }
      });
    });
  }

  private settle(res: ResponseMsg): void {
    const p = this.pending.get(res.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(res.id);
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error(res.error ?? "Figma request failed"));
  }

  private async elect(): Promise<void> {
    for (let attempt = 0; attempt < 20 && !this.closed; attempt++) {
      if (await this.tryListen()) return;
      if (await this.tryConnect()) return;
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 350));
    }
    throw new Error(`Loupe could not bind or reach port ${this.port}. Is another program using it? Set LOUPE_PORT to change it (and the plugin's port).`);
  }

  private tryListen(): Promise<boolean> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ host: this.host, port: this.port, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
      const onError = (err: NodeJS.ErrnoException) => {
        wss.close();
        if (err.code !== "EADDRINUSE") this.log(`listen failed: ${err.message}`);
        resolve(false);
      };
      wss.once("error", onError);
      wss.once("listening", () => {
        wss.off("error", onError);
        wss.on("error", (e) => this.log(`hub error: ${e.message}`));
        this.wss = wss;
        this.role = "hub";
        this.peerPlugins = [];
        wss.on("connection", (ws, req) => this.onConnection(ws, req));
        this.heartbeat = setInterval(() => this.ping(), 15_000);
        this.log(`hub listening on ${this.host}:${this.port}`);
        resolve(true);
      });
    });
  }

  private tryConnect(): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://${this.host}:${this.port}`, { maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(ok);
      };
      const t = setTimeout(() => {
        ws.terminate();
        finish(false);
      }, 2_000);
      ws.on("open", () => ws.send(JSON.stringify({ t: "hello", role: "peer", protocol: PROTOCOL_VERSION })));
      ws.on("message", (data) => {
        let msg: AnyMsg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (msg.t === "welcome") {
          this.hubSocket = ws;
          this.role = "peer";
          this.log("connected to hub as peer");
          finish(true);
        } else if (msg.t === "plugins") {
          this.peerPlugins = msg.plugins;
          if (msg.plugins.length) this.wake();
        } else if (msg.t === "res") {
          this.settle(msg);
        }
      });
      ws.on("error", () => finish(false));
      ws.on("close", () => {
        finish(false);
        if (this.hubSocket !== ws) return;
        this.hubSocket = undefined;
        this.peerPlugins = [];
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("Lost the connection to the Loupe hub; retry the call."));
          this.pending.delete(id);
        }
        if (!this.closed) {
          this.role = "starting";
          this.start().catch((e) => this.log(`re-election failed: ${e.message}`));
        }
      });
    });
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const allowed = allowedOrigin(req.headers.origin);
    if (!allowed) {
      this.log(`rejected connection from origin ${req.headers.origin}`);
      ws.close(1008, "origin not allowed");
      return;
    }
    let registered: "plugin" | "peer" | undefined;
    let conn: string | undefined;
    const helloTimer = setTimeout(() => {
      if (!registered) ws.close(1008, "hello expected");
    }, 10_000);

    ws.on("message", (data) => {
      let msg: AnyMsg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!registered) {
        if (msg.t !== "hello" || msg.role !== allowed) {
          ws.close(1008, "unexpected hello");
          return;
        }
        clearTimeout(helloTimer);
        registered = msg.role;
        conn = randomUUID().slice(0, 8);
        if (msg.role === "plugin") {
          const h = msg as HelloPlugin;
          if (h.protocol !== PROTOCOL_VERSION) this.log(`plugin protocol ${h.protocol} ≠ server ${PROTOCOL_VERSION}`);
          const info: PluginInfo = {
            conn,
            fileName: h.fileName,
            fileKey: h.fileKey,
            pageId: h.pageId,
            pageName: h.pageName,
            editorType: h.editorType,
            user: h.user,
            pluginVersion: h.pluginVersion,
            protocol: h.protocol,
            selection: h.selection ?? [],
            activeAt: Date.now(),
          };
          this.plugins.set(conn, { ws, info, alive: true });
          ws.on("pong", () => {
            const c = this.plugins.get(conn!);
            if (c) c.alive = true;
          });
          this.log(`plugin connected: ${h.fileName}`);
          this.broadcast();
          this.wake();
        } else {
          this.peers.add(ws);
        }
        ws.send(JSON.stringify({ t: "welcome", role: msg.role, conn, serverVersion: SERVER_VERSION }));
        if (msg.role === "peer") ws.send(JSON.stringify({ t: "plugins", plugins: this.list() }));
        return;
      }

      if (registered === "plugin") {
        if (msg.t === "res") {
          const fwd = this.forwarded.get(msg.id);
          if (fwd) {
            this.forwarded.delete(msg.id);
            if (fwd.ws.readyState === WebSocket.OPEN) fwd.ws.send(JSON.stringify({ ...msg, id: fwd.id }));
          } else this.settle(msg);
        } else if (msg.t === "state") {
          const c = this.plugins.get(conn!);
          if (c) {
            Object.assign(c.info, { pageId: msg.pageId, pageName: msg.pageName, fileName: msg.fileName, selection: msg.selection ?? [], activeAt: Date.now() });
            this.broadcast();
          }
        }
        return;
      }

      // Peer.
      if (msg.t === "list") {
        ws.send(JSON.stringify({ t: "plugins", plugins: this.list() }));
      } else if (msg.t === "req") {
        let target: PluginConn | undefined;
        try {
          target = this.plugins.get(this.pick(msg.target).conn);
        } catch (e) {
          ws.send(JSON.stringify({ t: "res", id: msg.id, ok: false, error: (e as Error).message }));
          return;
        }
        if (!target) {
          ws.send(JSON.stringify({ t: "res", id: msg.id, ok: false, error: "plugin disconnected" }));
          return;
        }
        const id = randomUUID();
        this.forwarded.set(id, { ws, id: msg.id, conn: target.info.conn });
        target.ws.send(JSON.stringify({ t: "req", id, method: msg.method, params: msg.params }));
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (registered === "plugin" && conn) {
        this.plugins.delete(conn);
        this.log("plugin disconnected");
        // Fail the requests that were waiting on this plugin.
        for (const [id, fwd] of this.forwarded) {
          if (fwd.conn !== conn) continue;
          if (fwd.ws.readyState === WebSocket.OPEN) {
            fwd.ws.send(JSON.stringify({ t: "res", id: fwd.id, ok: false, error: "The Figma plugin disconnected; run it again." }));
          }
          this.forwarded.delete(id);
        }
        for (const [id, p] of this.pending) {
          if (p.conn !== conn) continue;
          clearTimeout(p.timer);
          p.reject(new Error("The Figma plugin disconnected; run it again."));
          this.pending.delete(id);
        }
        this.broadcast();
      } else if (registered === "peer") {
        this.peers.delete(ws);
        for (const [id, fwd] of this.forwarded) if (fwd.ws === ws) this.forwarded.delete(id);
      }
    });
    ws.on("error", () => ws.terminate());
  }

  private broadcast(): void {
    const msg = JSON.stringify({ t: "plugins", plugins: this.list() });
    for (const p of this.peers) if (p.readyState === WebSocket.OPEN) p.send(msg);
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  private ping(): void {
    for (const [conn, c] of this.plugins) {
      if (!c.alive) {
        c.ws.terminate();
        this.plugins.delete(conn);
        this.broadcast();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }
}
