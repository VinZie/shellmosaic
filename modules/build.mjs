// Builds the optional modules and their catalog.
//
//   node modules/build.mjs                    build every module, write modules/index.json
//   node modules/build.mjs sqlite-browser     build one module (and the catalog)
//   node modules/build.mjs --sign             …and sign index.json with the updater key
//   node modules/build.mjs --dev <id>         dev server for one module, with its dev-mock data
//
// A module is a folder with manifest.json. One with a src/ folder is a React app
// (index.html + src/main.tsx) built by Vite into dist/; one without is copied as is.
// dist/ is what Shellmosaic downloads, so it is committed. index.json lists every
// module with the SHA-256 of each dist file; index.json.sig is its minisign signature,
// made with the same key as the app's updates, which the app checks before installing.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build, createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const named = args.filter((a) => !a.startsWith("--"));

const modules = readdirSync(here)
  .filter((d) => existsSync(join(here, d, "manifest.json")))
  .sort();

/** The host serves /__sdk/shellmosaic.js; the dev server has no host, the mock stands in. */
const sdkStub = () => ({
  name: "shellmosaic-sdk-stub",
  configureServer(server) {
    server.middlewares.use("/__sdk/shellmosaic.js", (_req, res) => {
      res.setHeader("Content-Type", "text/javascript");
      res.end("/* no Shellmosaic host in dev: the module's dev-mock stands in */");
    });
  },
});

function viteConfig(dir) {
  return {
    root: dir,
    base: "./",
    configFile: false,
    logLevel: "warn",
    plugins: [react(), sdkStub()],
    build: {
      outDir: join(dir, "dist"),
      emptyOutDir: true,
      target: "chrome120",
      modulePreload: false,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 4000,
      rollupOptions: {
        input: join(dir, "index.html"),
        // stable names: a rebuild without changes leaves git (and the catalog) unchanged
        output: { entryFileNames: "app.js", chunkFileNames: "app-[name].js", assetFileNames: "app[extname]" },
      },
    },
  };
}

function readManifest(id) {
  const m = JSON.parse(readFileSync(join(here, id, "manifest.json"), "utf8"));
  if (m.id !== id) throw new Error(`${id}/manifest.json: "id" must be "${id}"`);
  for (const k of ["name", "version", "minAppVersion"]) if (typeof m[k] !== "string") throw new Error(`${id}/manifest.json needs "${k}"`);
  return m;
}

async function buildModule(id) {
  const dir = join(here, id);
  const dist = join(dir, "dist");
  readManifest(id);
  if (existsSync(join(dir, "src"))) {
    await build(viteConfig(dir));
  } else {
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (f === "dist" || f === "README.md" || f.startsWith(".")) continue;
      cpSync(join(dir, f), join(dist, f), { recursive: true });
    }
  }
  cpSync(join(dir, "manifest.json"), join(dist, "manifest.json"));
  console.log(`built ${id}`);
}

function filesOf(dir) {
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

function writeCatalog() {
  const entries = modules.map((id) => {
    const m = readManifest(id);
    const dist = join(here, id, "dist");
    if (!existsSync(dist)) throw new Error(`${id} isn't built yet`);
    const files = filesOf(dist).map((p) => {
      const data = readFileSync(p);
      return { path: relative(dist, p).replaceAll("\\", "/"), sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
    });
    return {
      id,
      name: m.name,
      version: m.version,
      description: m.description ?? "",
      icon: m.icon ?? "puzzle",
      author: m.author ?? null,
      permissions: m.permissions ?? [],
      minAppVersion: m.minAppVersion,
      files,
    };
  });
  const catalog = { schema: 1, modules: entries.sort((a, b) => a.name.localeCompare(b.name)) };
  writeFileSync(join(here, "index.json"), JSON.stringify(catalog, null, 2) + "\n");
  console.log(`wrote modules/index.json (${entries.length} modules)`);
}

function sign() {
  const key = process.env.SHELLMOSAIC_SIGNING_KEY ?? join(homedir(), ".tauri", "shellmosaic-updater.key");
  if (!existsSync(key)) throw new Error(`signing key not found: ${key}`);
  rmSync(join(here, "index.json.sig"), { force: true });
  // the CLI's own entry point, run by this Node (no shell: it would drop the empty password)
  const tauri = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  execFileSync(process.execPath, [tauri, "signer", "sign", "-f", key, "-p", "", join(here, "index.json")], { stdio: ["ignore", "ignore", "inherit"] });
  if (!existsSync(join(here, "index.json.sig"))) throw new Error("signing didn't produce index.json.sig");
  console.log("signed modules/index.json");
}

if (flag("--dev")) {
  const id = named[0];
  if (!id || !modules.includes(id)) throw new Error(`usage: node modules/build.mjs --dev <${modules.join("|")}>`);
  const server = await createServer({ ...viteConfig(join(here, id)), logLevel: "info", server: { port: 5180 + modules.indexOf(id), strictPort: false } });
  await server.listen();
  server.printUrls();
} else {
  for (const id of named.length ? named : modules) {
    if (!modules.includes(id)) throw new Error(`no module "${id}" (have: ${modules.join(", ")})`);
    await buildModule(id);
  }
  // the catalog lists every module: it can only be written once all of them are built
  const unbuilt = modules.filter((id) => !existsSync(join(here, id, "dist")));
  if (unbuilt.length) {
    console.log(`index.json not written: build ${unbuilt.join(", ")} too (or run without names)`);
    if (flag("--sign")) process.exit(1);
  } else writeCatalog();
  if (flag("--sign")) sign();
}
