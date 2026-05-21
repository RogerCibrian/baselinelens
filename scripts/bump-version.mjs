#!/usr/bin/env node
// Bumps the app version across package.json, src-tauri/tauri.conf.json,
// and src-tauri/Cargo.toml so they stay in sync.
//
// Usage:
//   node scripts/bump-version.mjs <semver>
//   npm run bump-version -- <semver>      (the `--` is required so npm
//                                          passes the version through)
//
// After running, `npm install --package-lock-only` refreshes the
// lockfile, and the next `cargo build` refreshes Cargo.lock.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const next = process.argv[2];
if (!next || !SEMVER.test(next)) {
  console.error("Usage: node scripts/bump-version.mjs <semver>");
  console.error("       e.g. node scripts/bump-version.mjs 0.2.0");
  process.exit(1);
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function patchJson(file, key) {
  const path = resolve(repo, file);
  const data = JSON.parse(await readFile(path, "utf8"));
  const prev = data[key];
  data[key] = next;
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
  return prev;
}

async function patchCargoToml(file) {
  const path = resolve(repo, file);
  const text = await readFile(path, "utf8");
  // Single-package crate: the first `version = "x.y.z"` line is the
  // [package] section's version.
  const match = text.match(/^version = "([^"]+)"$/m);
  if (!match) throw new Error(`No version line found in ${file}`);
  await writeFile(path, text.replace(match[0], `version = "${next}"`));
  return match[1];
}

const changes = [
  ["package.json", await patchJson("package.json", "version")],
  ["src-tauri/tauri.conf.json", await patchJson("src-tauri/tauri.conf.json", "version")],
  ["src-tauri/Cargo.toml", await patchCargoToml("src-tauri/Cargo.toml")],
];

console.log(`Bumped to ${next}:`);
for (const [file, prev] of changes) {
  console.log(`  ${file.padEnd(30)} ${prev} -> ${next}`);
}
console.log("\nNext: `npm install --package-lock-only` to refresh the lockfile.");
