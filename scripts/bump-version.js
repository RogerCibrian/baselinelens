#!/usr/bin/env node
// Bumps the app version across package.json, src-tauri/tauri.conf.json,
// and src-tauri/Cargo.toml so they stay in sync.
//
// Usage:
//   node scripts/bump-version.js <semver>
//   npm run bump-version -- <semver>      (the `--` is required so npm
//                                          passes the version through)
//
// All three files are read first; if the new version isn't strictly
// greater than every current value, nothing is written — partial bumps
// would leave the repo in a mixed state that's a pain to recover from.
//
// After running, `npm install --package-lock-only` refreshes the
// lockfile, and the next `cargo build` refreshes Cargo.lock.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import semver from "semver";

const next = process.argv[2];
if (!next) {
  console.error("Usage: node scripts/bump-version.js <semver>");
  console.error("       e.g. node scripts/bump-version.js 0.2.0");
  process.exit(1);
}
if (!semver.valid(next)) {
  console.error(`'${next}' is not a valid semver string.`);
  process.exit(1);
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJsonVersion(file, key) {
  const path = resolve(repo, file);
  const data = JSON.parse(await readFile(path, "utf8"));
  if (!(key in data)) {
    throw new Error(`Key '${key}' not found in ${file}`);
  }
  return { kind: "json", file, path, data, key, prev: data[key] };
}

async function readCargoVersion(file) {
  const path = resolve(repo, file);
  const text = await readFile(path, "utf8");
  // Single-package crate: the first `version = "x.y.z"` line is the
  // [package] section's version.
  const match = text.match(/^version = "([^"]+)"$/m);
  if (!match) throw new Error(`No version line found in ${file}`);
  return { kind: "cargo", file, path, text, match, prev: match[1] };
}

async function writeBump(target) {
  if (target.kind === "json") {
    target.data[target.key] = next;
    await writeFile(target.path, JSON.stringify(target.data, null, 2) + "\n");
  } else {
    await writeFile(target.path, target.text.replace(target.match[0], `version = "${next}"`));
  }
}

const targets = [
  await readJsonVersion("package.json", "version"),
  await readJsonVersion("src-tauri/tauri.conf.json", "version"),
  await readCargoVersion("src-tauri/Cargo.toml"),
];

const stale = targets.filter((t) => !semver.gt(next, t.prev));
if (stale.length > 0) {
  console.error(`Refusing to bump to ${next} — not strictly greater than:`);
  for (const t of stale) {
    console.error(`  ${t.file.padEnd(30)} ${t.prev}`);
  }
  process.exit(1);
}

for (const t of targets) {
  await writeBump(t);
}

console.log(`Bumped to ${next}:`);
for (const t of targets) {
  console.log(`  ${t.file.padEnd(30)} ${t.prev} -> ${next}`);
}
console.log("\nNext: `npm install --package-lock-only` to refresh the lockfile.");
