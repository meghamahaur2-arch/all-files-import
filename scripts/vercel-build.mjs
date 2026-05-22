/**
 * Post-build adapter that turns Vite's `dist/client` + `dist/server`
 * into Vercel's Build Output API v3 layout under `.vercel/output/`.
 *
 *   .vercel/output/
 *     config.json
 *     static/                 ← all of dist/client/* (favicons, og, icons, /paymemo-extension.zip)
 *     functions/_render.func/
 *       .vc-config.json       (nodejs22.x runtime, Web-standard fetch handler)
 *       package.json          ({ "type": "module" })
 *       index.mjs             (single-file SSR bundle — all node_modules inlined by esbuild)
 *
 * The Cloudflare Vite plugin (which we disabled for the Vercel target) used to do
 * its own bundling/inlining. Without it the SSR entry pulls in raw imports from
 * node_modules, which a Vercel function dir does not ship by default — so we
 * bundle the whole graph into one self-contained ESM file with esbuild.
 *
 * Run from package.json via:
 *     "buildCommand": "npm run build && node scripts/vercel-build.mjs"
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const distClient = path.join(root, "dist/client");
const distServer = path.join(root, "dist/server");
const distServerEntry = path.join(distServer, "server.js");
const out = path.join(root, ".vercel/output");
const outStatic = path.join(out, "static");
const outFunc = path.join(out, "functions/_render.func");

async function rmrf(target) {
  await fs.rm(target, { recursive: true, force: true });
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) return copyDir(s, d);
      return fs.copyFile(s, d);
    }),
  );
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(distClient)) || !(await exists(distServerEntry))) {
    throw new Error(
      "Missing dist/client or dist/server/server.js — run `npm run build` first.",
    );
  }

  await rmrf(out);
  await fs.mkdir(out, { recursive: true });

  // 1. config.json — try filesystem first, fall back to the SSR function.
  const config = {
    version: 3,
    routes: [
      // Long-cache hashed assets shipped by Vite.
      {
        src: "^/assets/(.*)$",
        headers: {
          "cache-control": "public, max-age=31536000, immutable",
        },
        continue: true,
      },
      {
        src: "^/icons/(.*)$",
        headers: {
          "cache-control": "public, max-age=86400",
        },
        continue: true,
      },
      // Try static files (favicon, og-image, /paymemo-extension.zip, etc.).
      { handle: "filesystem" },
      // Everything else → SSR.
      { src: "/(.*)", dest: "/_render" },
    ],
  };
  await fs.writeFile(
    path.join(out, "config.json"),
    JSON.stringify(config, null, 2),
  );

  // 2. Copy the static build.
  await copyDir(distClient, outStatic);

  // 3. Build the SSR function — esbuild bundles everything into a single ESM file.
  await fs.mkdir(outFunc, { recursive: true });

  // Write an entry that adapts TanStack Start's Web fetch handler to Vercel's
  // Node 22 expected signature: `export default (req: Request) => Promise<Response>`.
  const adapterEntry = path.join(distServer, "_vercel-entry.mjs");
  await fs.writeFile(
    adapterEntry,
    `import server from "./server.js";\nexport default async function handler(request) {\n  return server.fetch(request);\n}\n`,
  );

  try {
    await esbuild({
      entryPoints: [adapterEntry],
      outfile: path.join(outFunc, "index.mjs"),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      // Tell esbuild to leave Node built-ins alone and to inline every npm dep.
      packages: "bundle",
      external: [],
      // The SSR bundle imports `./assets/server-*.js` with a static literal path,
      // so esbuild can resolve and inline it. Banner makes top-level await safe.
      banner: {
        js: "import { createRequire as __pmCreateRequire } from 'node:module'; const require = __pmCreateRequire(import.meta.url);",
      },
      logLevel: "info",
      legalComments: "none",
      sourcemap: false,
      minify: false,
    });
  } finally {
    await rmrf(adapterEntry);
  }

  // Vercel needs to know the function is ESM.
  await fs.writeFile(
    path.join(outFunc, "package.json"),
    JSON.stringify({ type: "module" }, null, 2),
  );

  await fs.writeFile(
    path.join(outFunc, ".vc-config.json"),
    JSON.stringify(
      {
        runtime: "nodejs22.x",
        handler: "index.mjs",
        launcherType: "Nodejs",
        shouldAddHelpers: false,
        supportsResponseStreaming: true,
      },
      null,
      2,
    ),
  );

  console.log("✓ Vercel Build Output API written to", path.relative(root, out));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

