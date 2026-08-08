#!/usr/bin/env node
// Black-box acceptance checks for the fiducia-cloud Cloudflare estate.
//
// Two tiers, because test-plan.json declares `pullRequestCredentials: false`:
//
//   tier 1  credential-free. Public DNS + public HTTPS only. Safe on pull
//           requests from forks; runs everywhere, always.
//   tier 2  credentialed. Skipped unless CLOUDFLARE_ACCOUNT_ID + R2 keys are
//           present. Asserts the blast radius of the R2 parent key, which is
//           the one property that cannot be observed from outside.
//
// No dependencies: DNS goes over DoH and S3 requests are signed with SigV4
// implemented against node:crypto, so this runs on a bare runner.
//
// Exit code is non-zero if any executed check fails. Skipped checks never fail
// the run, but they are reported, so a silently credential-less job cannot be
// mistaken for a passing security gate.

import { createHmac, createHash } from "node:crypto";

const ZONE = "fiducia.cloud";
const TUNNEL_HOST = "localhost-test.fiducia.cloud";

// Bucket ids are public identifiers (they appear in the r2.dev hostname); the
// point of the check is that these URLs must NOT serve object content.
const R2_PUBLIC_IDS = {
  "fiducia-kv-backups-prod": "f706649b0716470bbf372a1f970e5521",
  "fiducia-logs-prod": "51a114875f6043189ab294e4677ed139",
  "fiducia-artifacts-prod": "ed69fd47fd614d098582ee05b5b8d87d",
  "fiducia-web-assets-prod": "2ed71172c2974e9a95ecd61d90386111",
};

const FIDUCIA_BUCKETS = Object.keys(R2_PUBLIC_IDS);
// Buckets belonging to other products in the same Cloudflare account. Fiducia
// credentials must not reach these. This is the DEN-2762 gate.
const FOREIGN_BUCKETS = [
  "sonus-auris-segments-prod",
  "sonus-auris-downloads-prod",
  "zed-pkg-artifacts",
];

const results = [];
const record = (tier, name, status, detail) =>
  results.push({ tier, name, status, detail });
const pass = (t, n, d) => record(t, n, "pass", d);
const fail = (t, n, d) => record(t, n, "fail", d);
const skip = (t, n, d) => record(t, n, "skip", d);

async function doh(name, type) {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
  const r = await fetch(url, { headers: { accept: "application/dns-json" } });
  if (!r.ok) throw new Error(`DoH ${type} ${name}: HTTP ${r.status}`);
  const j = await r.json();
  return (j.Answer || []).map((a) => a.data);
}

async function status(url, opts = {}) {
  try {
    const r = await fetch(url, { redirect: "manual", ...opts });
    return r.status;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- tier 1

async function tier1PublicBucketsClosed() {
  for (const [bucket, id] of Object.entries(R2_PUBLIC_IDS)) {
    const code = await status(`https://pub-${id}.r2.dev/`);
    // 401/403 = managed public access disabled. 200 would mean the bucket is
    // world-readable over its r2.dev hostname.
    if (code === 401 || code === 403 || code === 404) {
      pass("1", `r2 public access closed: ${bucket}`, `HTTP ${code}`);
    } else if (code === 0) {
      fail("1", `r2 public access closed: ${bucket}`, "no response (cannot prove closed)");
    } else {
      fail("1", `r2 public access closed: ${bucket}`, `HTTP ${code} — bucket is publicly served`);
    }
  }
}

async function tier1TunnelHostProxied() {
  // A cfargotunnel CNAME must stay proxied. If it ever resolves to a routable
  // origin address, the tunnel has been replaced by a direct-exposed host.
  let answers;
  try {
    answers = await doh(TUNNEL_HOST, "A");
  } catch (e) {
    fail("1", "tunnel host resolves", e.message);
    return;
  }
  if (answers.length === 0) {
    fail("1", "tunnel host resolves", `${TUNNEL_HOST} has no A record`);
    return;
  }
  // Cloudflare proxy space: 104.16/12 and 172.64/13 cover the anycast ranges
  // these records land in.
  const proxied = answers.every(
    (ip) => /^104\.(1[6-9]|2\d|3[01])\./.test(ip) || /^172\.(6[4-9]|7\d)\./.test(ip),
  );
  proxied
    ? pass("1", "tunnel host is Cloudflare-proxied", answers.join(", "))
    : fail("1", "tunnel host is Cloudflare-proxied", `unproxied origin exposed: ${answers.join(", ")}`);
}

// DoH hands back CAA in RFC 3597 unknown-record form -- `\# <len> <hex bytes>`
// -- not as text. A naive substring match against that string silently never
// matches, which reads as "CAA does not permit this CA" for a zone that permits
// it fine. Decode properly: 1 byte flags, 1 byte tag length, tag, then value.
function decodeCaa(raw) {
  const m = /^\\?#\s+\d+\s+([0-9a-fA-F ]+)$/.exec(raw.trim());
  if (!m) return raw; // already text form (some resolvers)
  const bytes = m[1].trim().split(/\s+/).map((h) => parseInt(h, 16));
  if (bytes.length < 2) return "";
  const tagLen = bytes[1];
  const tag = String.fromCharCode(...bytes.slice(2, 2 + tagLen));
  const value = String.fromCharCode(...bytes.slice(2 + tagLen));
  return `${tag} ${value}`;
}

async function tier1CaaCoversLiveIssuers() {
  const decoded = (await doh(ZONE, "CAA")).map(decodeCaa);
  const caa = decoded.join(" ");
  if (!caa.trim()) {
    fail("1", "CAA present", "no CAA records — any CA may issue for this zone");
    return;
  }
  const issueCount = decoded.filter((d) => d.startsWith("issue ")).length;
  pass("1", "CAA present", `${issueCount} issue entries, ${decoded.length} total`);

  // Whatever CAA says, it must permit the CAs actually serving the zone today,
  // or renewal breaks silently weeks later.
  const live = {
    "letsencrypt.org": "apex/www (GitHub Pages)",
    "pki.goog": "proxied hosts (Cloudflare Universal SSL)",
  };
  for (const [ca, why] of Object.entries(live)) {
    caa.includes(ca)
      ? pass("1", `CAA permits ${ca}`, why)
      : fail("1", `CAA permits ${ca}`, `${why} would fail to renew`);
  }
}

async function tier1MailPostureIntact() {
  // Regression guard. A careless edit to this zone silently breaks mail, and
  // DMARC p=reject means failures are rejections, not spam-folder placements.
  const txt = (await doh(ZONE, "TXT")).join(" ");
  txt.includes("v=spf1")
    ? pass("1", "SPF present", "")
    : fail("1", "SPF present", "sending domain unprotected");

  const mx = await doh(ZONE, "MX");
  mx.length > 0
    ? pass("1", "MX present", `${mx.length} record(s)`)
    : fail("1", "MX present", "mail delivery would fail");

  const dmarc = (await doh(`_dmarc.${ZONE}`, "TXT")).join(" ");
  dmarc.includes("p=reject")
    ? pass("1", "DMARC p=reject", "")
    : fail("1", "DMARC p=reject", `weakened: ${dmarc || "absent"}`);

  // Known-open finding rather than a hard gate: DKIM is published but empty,
  // so DMARC is leaning entirely on SPF alignment.
  const dkim = (await doh(`_domainkey.${ZONE}`, "TXT")).join(" ");
  /p=([A-Za-z0-9+/]{20,})/.test(dkim)
    ? pass("1", "DKIM key published", "")
    : record("1", "DKIM key published", "known-open", "empty p= while DMARC is p=reject");
}

async function tier1Dnssec() {
  const ds = await doh(ZONE, "DS");
  ds.length > 0
    ? pass("1", "DNSSEC DS published at registrar", ds.length + " DS record(s)")
    : record("1", "DNSSEC DS published at registrar", "known-open",
             "zone is signed but the registrar DS is not published, so nothing validates");
}

// ---------------------------------------------------------------- SigV4

function sigv4Headers({ method, host, path, query, accessKeyId, secretAccessKey, sessionToken }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";
  const payloadHash = createHash("sha256").update("").digest("hex");

  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;

  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort()
    .map((k) => `${k}:${headers[k]}\n`).join("");

  const canonicalRequest = [
    method, path, query, canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
  let k = hmac(`AWS4${secretAccessKey}`, dateStamp);
  k = hmac(k, region);
  k = hmac(k, service);
  k = hmac(k, "aws4_request");
  const signature = createHmac("sha256", k).update(stringToSign).digest("hex");

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

async function listBucket(creds, bucket) {
  const host = `${creds.accountId}.r2.cloudflarestorage.com`;
  const path = `/${bucket}`;
  const query = "list-type=2&max-keys=1";
  const headers = sigv4Headers({ method: "GET", host, path, query, ...creds });
  try {
    const r = await fetch(`https://${host}${path}?${query}`, { headers });
    return r.status;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- tier 2

// Returns true when the parent key proved to be bucket-scoped, which changes
// what the scoped-credential checks below are allowed to expect.
async function tier2BlastRadius(creds) {
  // Positive control first: if the key cannot read its own buckets, the
  // credentials are broken and the denials below would be meaningless.
  const own = await listBucket(creds, FIDUCIA_BUCKETS[0]);
  if (own !== 200) {
    fail("2", "R2 parent key can read fiducia buckets",
         `HTTP ${own} on ${FIDUCIA_BUCKETS[0]} — credentials invalid, denial results below are not meaningful`);
    return false;
  }
  pass("2", "R2 parent key can read fiducia buckets", `HTTP 200 on ${FIDUCIA_BUCKETS[0]}`);

  // DEN-2762. Fiducia credentials must not reach another product's storage.
  let scoped = true;
  for (const b of FOREIGN_BUCKETS) {
    const code = await listBucket(creds, b);
    if (code === 403 || code === 401) {
      pass("2", `R2 key denied on foreign bucket: ${b}`, `HTTP ${code}`);
    } else {
      scoped = false;
      fail("2", `R2 key denied on foreign bucket: ${b}`,
           `HTTP ${code} — fiducia credentials reach another product's object storage (DEN-2762)`);
    }
  }
  return scoped;
}

async function mintScoped(creds, bucket, permission) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/r2/temp-access-credentials`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${creds.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        bucket, parentAccessKeyId: creds.accessKeyId, permission, ttlSeconds: 900,
      }),
    },
  );
  const j = await r.json();
  if (!j.success) return null;
  return {
    accountId: creds.accountId,
    accessKeyId: j.result.accessKeyId,
    secretAccessKey: j.result.secretAccessKey,
    sessionToken: j.result.sessionToken,
  };
}

async function tier2ScopedCredsEnforced(creds, parentIsScoped) {
  if (!creds.apiToken) {
    skip("2", "scoped credentials enforce bucket scope", "CLOUDFLARE_API_TOKEN not set");
    return;
  }
  const target = "fiducia-logs-prod";
  const scoped = await mintScoped(creds, target, "object-read-only");
  if (!scoped) {
    // `r2/temp-access-credentials` needs an ACCOUNT-LEVEL R2 permission, which a
    // correctly bucket-scoped parent key deliberately does not have. So this
    // failing is only a problem when the parent is still account-wide -- there,
    // temp credentials are the mitigation and their absence leaves nothing
    // between a leaked key and every bucket in the account.
    parentIsScoped
      ? record("2", "scoped credentials can be minted", "known-open",
               "unavailable because the parent key is bucket-scoped, which is the stronger control — expected")
      : fail("2", "scoped credentials can be minted",
             "temp-access-credentials refused while the parent key is account-wide — no mitigation available (DEN-2762)");
    return;
  }
  pass("2", "scoped credentials can be minted", target);

  const inScope = await listBucket(scoped, target);
  inScope === 200
    ? pass("2", "scoped creds read in-scope bucket", "HTTP 200")
    : fail("2", "scoped creds read in-scope bucket", `HTTP ${inScope}`);

  for (const b of [...FOREIGN_BUCKETS, "fiducia-kv-backups-prod"]) {
    const code = await listBucket(scoped, b);
    code === 403 || code === 401
      ? pass("2", `scoped creds denied outside scope: ${b}`, `HTTP ${code}`)
      : fail("2", `scoped creds denied outside scope: ${b}`,
             `HTTP ${code} — scope is not enforced`);
  }
}

// ---------------------------------------------------------------- runner

async function main() {
  const creds = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  };

  await tier1PublicBucketsClosed();
  await tier1TunnelHostProxied();
  await tier1CaaCoversLiveIssuers();
  await tier1MailPostureIntact();
  await tier1Dnssec();

  if (creds.accountId && creds.accessKeyId && creds.secretAccessKey) {
    await tier2BlastRadius(creds);
    await tier2ScopedCredsEnforced(creds);
  } else {
    skip("2", "R2 blast-radius checks",
         "set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY to run");
  }

  const width = Math.max(...results.map((r) => r.name.length));
  const glyph = { pass: "PASS", fail: "FAIL", skip: "SKIP", "known-open": "OPEN" };
  for (const r of results) {
    console.log(
      `  [${glyph[r.status]}] t${r.tier} ${r.name.padEnd(width)}  ${r.detail || ""}`.trimEnd(),
    );
  }

  const n = (s) => results.filter((r) => r.status === s).length;
  console.log(
    `\n  ${n("pass")} passed, ${n("fail")} failed, ${n("known-open")} known-open, ${n("skip")} skipped`,
  );
  if (n("known-open")) {
    console.log("  known-open = accepted finding, tracked but not yet fixed; does not fail the run.");
  }
  process.exit(n("fail") > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("acceptance run crashed:", e);
  process.exit(2);
});
