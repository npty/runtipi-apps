// End-to-end tests: run src/pdf-unlocker.ts once against a fake Nextcloud (WebDAV) and fake Stirling.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";

const plain = new Uint8Array(await Bun.file("test/fixtures/plain.pdf").arrayBuffer());
const encrypted = new Uint8Array(await Bun.file("test/fixtures/encrypted.pdf").arrayBuffer());
const DIR = "/remote.php/dav/files/ripzery/";

type Stored = { bytes: Uint8Array; etag: string };
let files: Map<string, Stored>; // path -> content
let puts: string[];
let moves: string[];
let onPut: ((path: string) => void) | undefined;
let stirlingStatus: number;
let textBody: () => Uint8Array; // what the fake Stirling returns for pdf-to-text
let servers: ReturnType<typeof Bun.serve>[];

const dir = (p: string) => '<d:response><d:href>' + DIR + encodeURI(p) + '/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>';
const file = (p: string, f: Stored) =>
  '<d:response><d:href>' + DIR + encodeURI(p) + '</d:href><d:propstat><d:prop><d:getetag>&quot;' + f.etag +
  '&quot;</d:getetag><d:getcontentlength>' + f.bytes.length + '</d:getcontentlength><d:resourcetype/></d:prop></d:propstat></d:response>';

beforeEach(() => {
  files = new Map();
  puts = [];
  moves = [];
  onPut = undefined;
  stirlingStatus = 200;
  textBody = () => new TextEncoder().encode(STATEMENT);
  const nextcloud = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname.slice(DIR.length)).replace(/\/+$/, "");
      if (req.method === "PROPFIND") {
        const kids = [...files.entries()].filter(([p]) => p.startsWith(path + "/") && !p.slice(path.length + 1).includes("/"));
        const subdirs = new Set([...files.keys()].filter((p) => p.startsWith(path + "/") && p.slice(path.length + 1).includes("/"))
          .map((p) => path + "/" + p.slice(path.length + 1).split("/")[0]));
        const xml = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">' + dir(path) + [...subdirs].map(dir).join("") + kids.map(([p, f]) => file(p, f)).join("") + "</d:multistatus>";
        return new Response(xml, { status: 207 });
      }
      const f = files.get(path);
      if (req.method === "GET") {
        if (!f) return new Response("", { status: 404 });
        const r = req.headers.get("range");
        if (r?.startsWith("bytes=-")) return new Response(f.bytes.slice(-Number(r.slice(7))), { status: 206 });
        const m = r ? /bytes=(\d+)-(\d+)/.exec(r) : null;
        return new Response(m ? f.bytes.slice(Number(m[1]), Number(m[2]) + 1) : f.bytes, { status: m ? 206 : 200 });
      }
      if (req.method === "MOVE") {
        const dest = decodeURIComponent(new URL(req.headers.get("destination") ?? "").pathname.slice(DIR.length));
        if (!f) return new Response("", { status: 404 });
        if (files.has(dest)) return new Response("", { status: 412 }); // Overwrite: F
        files.set(dest, f);
        files.delete(path);
        moves.push(path + " -> " + dest);
        return new Response("", { status: 201 });
      }
      if (req.method === "PUT") {
        onPut?.(path);
        const cur = files.get(path); // re-read: the hook may have changed it mid-request
        if (!cur || req.headers.get("if-match") !== '"' + cur.etag + '"') return new Response("", { status: 412 });
        files.set(path, { bytes: new Uint8Array(await req.arrayBuffer()), etag: cur.etag + "x" });
        puts.push(path);
        return new Response("", { status: 204 });
      }
      return new Response("", { status: 405 });
    },
  });
  const stirling = Bun.serve({
    port: 0,
    async fetch(req) {
      if (stirlingStatus !== 200) return new Response("", { status: stirlingStatus });
      if (new URL(req.url).pathname.endsWith("/convert/pdf/text")) return new Response(textBody());
      const form = await req.formData();
      return form.get("password") === "secret" ? new Response(plain) : new Response("bad password", { status: 400 });
    },
  });
  servers = [nextcloud, stirling];
});
afterEach(() => servers.forEach((s) => s.stop(true)));

async function run(passwords: string, mode = "on", renameMode = "off") {
  const p = Bun.spawn(["bun", process.env.UNLOCKER_SCRIPT ?? "src/pdf-unlocker.ts"], {
    env: {
      PATH: process.env.PATH ?? "",
      NEXTCLOUD_URL: "http://localhost:" + servers[0].port,
      NEXTCLOUD_USER: "ripzery",
      NEXTCLOUD_APP_PASSWORD: "x",
      STIRLING_URL: "http://localhost:" + servers[1].port,
      STIRLING_API_KEY: "k",
      WATCH_FOLDERS: "Finance",
      PASSWORDS: passwords,
      MODE: mode,
      RENAME_MODE: renameMode,
      ONCE: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out };
}

const put = (path: string, bytes: Uint8Array) => files.set(path, { bytes, etag: "e1" });
// Page 1 of an ADCB card statement, as Stirling's text conversion returns it.
const STATEMENT = "Page 1 of 2\nPHUCHIT\nXXXXXXXXXXXX2418\n05/10/26\n30/10/26\n0.00\n05/09/2026 SHOP 12.00\nPage 2 of 2\n";
const NAME = "Finance/2026-10 - ADCB - Card Statement (3).pdf";
const NEW_NAME = "Finance/2026-10 - ADCB 2418 - Card Statement.pdf";

// A one-entry zip with a data descriptor (sizes 0 in the local header), the way Java's ZipOutputStream writes it.
function zipOf(text: string): Uint8Array {
  const raw = new TextEncoder().encode(text);
  const comp = new Uint8Array(deflateRawSync(raw));
  const name = new TextEncoder().encode("out.txt");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 6); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 8); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(name.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  const body = Buffer.concat([local, name, comp]);
  cd.writeUInt32LE(0, 42);
  eocd.writeUInt32LE(cd.length + name.length, 12); eocd.writeUInt32LE(body.length, 16);
  return new Uint8Array(Buffer.concat([body, cd, name, eocd]));
}

const same = (a: Uint8Array | undefined, b: Uint8Array) => a !== undefined && Buffer.compare(a, b) === 0;

test("replaces an encrypted PDF in place and leaves a plain one alone", async () => {
  put("Finance/a/locked.pdf", encrypted);
  put("Finance/open.pdf", plain);
  const r = await run("wrong, secret");
  expect(r.code).toBe(0);
  expect(same(files.get("Finance/a/locked.pdf")?.bytes, plain)).toBe(true);
  expect(puts).toEqual(["Finance/a/locked.pdf"]);
  expect(r.out).toContain("unlocked Finance/a/locked.pdf");
});

test("dry mode proves the decrypt but changes nothing", async () => {
  put("Finance/locked.pdf", encrypted);
  const r = await run("secret", "dry");
  expect(puts).toEqual([]);
  expect(same(files.get("Finance/locked.pdf")?.bytes, encrypted)).toBe(true);
  expect(r.out).toContain("DRY RUN would unlock Finance/locked.pdf");
});

test("skips a file no configured password opens", async () => {
  put("Finance/locked.pdf", encrypted);
  const r = await run("nope");
  expect(puts).toEqual([]);
  expect(r.out).toContain("no configured password opened Finance/locked.pdf");
});

test("never overwrites a file that changed while unlocking", async () => {
  put("Finance/locked.pdf", encrypted);
  onPut = (path) => files.set(path, { bytes: encrypted, etag: "someone-else" });
  const r = await run("secret");
  expect(puts).toEqual([]);
  expect(same(files.get("Finance/locked.pdf")?.bytes, encrypted)).toBe(true);
  expect(r.out).toContain("changed while unlocking");
});

test("stops on a rejected Stirling API key instead of retrying passwords", async () => {
  put("Finance/locked.pdf", encrypted);
  stirlingStatus = 401;
  const r = await run("secret");
  expect(r.code).toBe(1);
  expect(r.out).toContain("Stirling rejected the API key");
  expect(puts).toEqual([]);
});

test("refuses a result under half the original size", async () => {
  put("Finance/locked.pdf", encrypted);
  // the fake Stirling always returns the small plain fixture, so a much bigger input trips the size guard
  put("Finance/big.pdf", new Uint8Array([...encrypted, ...new Uint8Array(5000)]));
  const r = await run("secret");
  expect(r.out).toContain("refusing to write Finance/big.pdf");
  expect(puts).toEqual(["Finance/locked.pdf"]);
});

test("renames an ADCB statement to its card and statement month", async () => {
  put(NAME, plain);
  const r = await run("secret", "on", "on");
  expect(moves).toEqual([NAME + " -> " + NEW_NAME]);
  expect(files.has(NAME)).toBe(false);
  expect(r.out).toContain("renamed " + NAME);
});

test("rename reads Stirling's answer when it comes back as a zip", async () => {
  put(NAME, plain);
  textBody = () => zipOf(STATEMENT);
  await run("secret", "on", "on");
  expect(moves).toEqual([NAME + " -> " + NEW_NAME]);
});

test("rename dry run logs the new name and moves nothing", async () => {
  put(NAME, plain);
  const r = await run("secret", "on", "dry");
  expect(moves).toEqual([]);
  expect(r.out).toContain("DRY RUN would rename " + NAME + " -> 2026-10 - ADCB 2418 - Card Statement.pdf");
});

test("rename never overwrites a file that already has the new name", async () => {
  put(NAME, plain);
  put(NEW_NAME, encrypted);
  const r = await run("secret", "off", "on");
  expect(moves).toEqual([]);
  expect(files.has(NAME)).toBe(true);
  expect(r.out).toContain("already exists");
});

test("rename leaves a file alone when the text has no card number", async () => {
  put(NAME, plain);
  textBody = () => new TextEncoder().encode("nothing useful here");
  const r = await run("secret", "on", "on");
  expect(moves).toEqual([]);
  expect(r.out).toContain("no card number or statement date found");
});

test("rename ignores names that already carry a card or are not ADCB statements", async () => {
  put(NEW_NAME, plain);
  put("Finance/2026-10 - ADCB Traveller - Statement.pdf", plain);
  put("Finance/open.pdf", plain);
  const r = await run("secret", "on", "on");
  expect(moves).toEqual([]);
  expect(r.out).not.toContain("renamed");
  expect(r.out).not.toContain("would rename");
});

test("an encrypted ADCB statement is unlocked first and renamed on the next pass", async () => {
  put(NAME, encrypted);
  await run("secret", "on", "on");
  expect(puts).toEqual([NAME]);
  expect(moves).toEqual([]); // still waiting for its second pass
  await run("secret", "on", "on");
  expect(moves).toEqual([NAME + " -> " + NEW_NAME]);
});
