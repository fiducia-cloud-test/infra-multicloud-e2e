import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const sourceRoot = process.env.SOURCE_ROOT;
if (!sourceRoot) throw new Error("SOURCE_ROOT is required");

const coordinatorRoot = path.join(sourceRoot, "modules/cloudflare/durable-coordinator");
const protocolPath = path.join(coordinatorRoot, "protocol.mjs");
const workerPath = path.join(coordinatorRoot, "worker.mjs");
const wranglerPath = path.join(coordinatorRoot, "wrangler.jsonc");
const infraManifestPath = path.join(sourceRoot, ".ores-infra.toml");

const protocol = await import(pathToFileURL(protocolPath));

test("modules-first provider roots remain canonical", () => {
  const manifest = fs.readFileSync(infraManifestPath, "utf8");
  assert.match(manifest, /layout\s*=\s*"modules"/);
  assert.match(manifest, /canonical_path\s*=\s*"modules\/cloudflare"/);
  assert.match(manifest, /canonical_path\s*=\s*"modules\/supabase"/);
  assert.match(manifest, /canonical_path\s*=\s*"modules\/neon"/);
  assert.match(manifest, /native_working_directory\s*=\s*"modules"/);
  assert.match(manifest, /project_root\s*=\s*"modules\/neon"/);
});

test("lease protocol rejects traversal and enforces deterministic expiry", () => {
  assert.equal(protocol.normalizeKey("lease:cluster/us-east-1"), "lease:cluster/us-east-1");
  assert.throws(() => protocol.normalizeKey("../cluster"), TypeError);
  assert.throws(() => protocol.normalizeKey("cluster/../../escape"), TypeError);
  assert.equal(protocol.normalizeTtlMs(1_000), 1_000);
  assert.throws(() => protocol.normalizeTtlMs(999), RangeError);
  assert.equal(protocol.leaseIsLive({ expires_at: 10_001 }, 10_000), true);
  assert.equal(protocol.leaseIsLive({ expires_at: 10_000 }, 10_000), false);
});

test("worker preserves transactional fencing semantics", () => {
  const worker = fs.readFileSync(workerPath, "utf8");
  assert.match(worker, /extends DurableObject/);
  assert.match(worker, /ctx\.storage\.transaction/);
  assert.match(worker, /current\.holder !== normalizedHolder/);
  assert.match(worker, /current\.fencing_token !== fencingToken/);
  assert.match(worker, /Math\.max\(counter, current\?\.fencing_token \?\? 0\) \+ 1/);
});

test("wrangler binds the expected coordinator in every environment", () => {
  const wrangler = fs.readFileSync(wranglerPath, "utf8");
  const bindingCount = (wrangler.match(/"name"\s*:\s*"COORDINATOR"/g) || []).length;
  const classCount = (wrangler.match(/"class_name"\s*:\s*"FiduciaLeaseCoordinator"/g) || []).length;
  assert.ok(bindingCount >= 4, `expected root + 3 environment bindings, got ${bindingCount}`);
  assert.equal(classCount, bindingCount);
  assert.match(wrangler, /"storage"\s*:\s*"sqlite"/);
});
