/** Turning what the agent passes (URL, ids, nothing) into node ids. */

export interface Target {
  ids: string[];
  fileKey?: string;
}

const ID = /^I?\d+[:-]\d+(;I?\d+[:-]\d+)*$/;

/** `12-34` (URL form) → `12:34`. Instance paths keep their `;` separators. */
export function normalizeId(id: string): string {
  const t = id.trim().replace(/^#/, "");
  if (!ID.test(t)) throw new Error(`"${id}" is not a Figma node id (expected something like 12:34)`);
  return t.replace(/(\d+)-(\d+)/g, "$1:$2");
}

/**
 * Accepts a Figma link (design/file/proto/board, with or without node-id),
 * one id, or several ids separated by commas or spaces.
 */
export function parseTarget(input: string | undefined): Target {
  const s = (input ?? "").trim();
  if (!s) return { ids: [] };
  if (/^https?:\/\//i.test(s)) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      throw new Error(`Could not parse the URL "${s}"`);
    }
    if (!/(^|\.)figma\.com$/i.test(url.hostname)) throw new Error(`Not a Figma URL: ${url.hostname}`);
    const parts = url.pathname.split("/").filter(Boolean);
    // /design/<key>/<name>, /design/<key>/branch/<branchKey>/<name>, /file/…, /proto/…, /board/…
    let fileKey: string | undefined;
    const kind = parts[0];
    if (kind && ["design", "file", "proto", "board", "slides", "make"].includes(kind)) {
      fileKey = parts[1];
      if (parts[2] === "branch" && parts[3]) fileKey = parts[3];
    }
    const nodeId = url.searchParams.get("node-id") ?? url.searchParams.get("starting-point-node-id");
    return { ids: nodeId ? [normalizeId(decodeURIComponent(nodeId))] : [], fileKey };
  }
  return { ids: s.split(/[\s,]+/).filter(Boolean).map(normalizeId) };
}
