#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const sourceDir = path.resolve(process.argv[2] || '_src/fiducia-infra');
const topologyPath = path.join(sourceDir, 'laptop', 'topology.toml');
const productionDocPath = path.join(sourceDir, 'docs', 'laptop-k3s-production.md');
const campaignPath = path.join(sourceDir, 'acceptance', 'laptop-fleet', 'campaign.json');

function fail(message) {
  console.error(`::error title=DEN-3008 contract failure::${message}`);
  console.error(`DEN-3008 contract failure: ${message}`);
  process.exit(1);
}

for (const file of [topologyPath, productionDocPath, campaignPath]) {
  if (!fs.existsSync(file)) fail(`required source file is missing: ${file}`);
}

const topology = fs.readFileSync(topologyPath, 'utf8');
const productionDoc = fs.readFileSync(productionDocPath, 'utf8');
const campaign = JSON.parse(fs.readFileSync(campaignPath, 'utf8'));

function requirePattern(text, pattern, message) {
  if (!pattern.test(text)) fail(message);
}

requirePattern(topology, /^cluster_id\s*=\s*"fiducia-prod"\s*$/m, 'cluster_id must remain fiducia-prod');
requirePattern(topology, /^replication_factor\s*=\s*3\s*$/m, 'replication_factor must be 3');
requirePattern(topology, /^connectivity\s*=\s*"wireguard"\s*$/m, 'private connectivity must be wireguard');
requirePattern(topology, /^auth_required\s*=\s*true\s*$/m, 'auth_required must be true');
requirePattern(topology, /^check_quorum\s*=\s*true\s*$/m, 'Raft check_quorum must be enabled');

const blocks = topology.split('[[cluster]]').slice(1);
if (blocks.length !== 3) fail(`expected exactly 3 synthetic provider clusters, found ${blocks.length}`);

const expected = [
  { name: 'laptop-aws-sim', provider: 'aws', site: 'site-a', pod: '10.41.0.0/16', service: '10.81.0.0/16' },
  { name: 'laptop-gcp-sim', provider: 'gcp', site: 'site-b', pod: '10.42.0.0/16', service: '10.82.0.0/16' },
  { name: 'laptop-azure-sim', provider: 'azure', site: 'site-c', pod: '10.43.0.0/16', service: '10.83.0.0/16' },
];

for (const item of expected) {
  const block = blocks.find((candidate) => candidate.includes(`name = "${item.name}"`));
  if (!block) fail(`missing cluster ${item.name}`);
  const required = [
    [`synthetic_provider = "${item.provider}"`, 'provider'],
    [`site = "${item.site}"`, 'site'],
    [`pod_cidr = "${item.pod}"`, 'pod CIDR'],
    [`service_cidr = "${item.service}"`, 'service CIDR'],
    ['platform = "local-laptop"', 'local-laptop substrate'],
    ['node_replicas = 1', 'one Fiducia node replica'],
    ['brain = true', 'Fiducia brain voter'],
  ];
  for (const [needle, label] of required) {
    if (!block.includes(needle)) fail(`${item.name} has incorrect ${label}`);
  }
}

const podCidrs = expected.map((x) => x.pod);
const serviceCidrs = expected.map((x) => x.service);
if (new Set(podCidrs).size !== 3 || new Set(serviceCidrs).size !== 3) {
  fail('cluster CIDRs must not overlap by reuse');
}

for (const phrase of [
  'one independent, single-node K3s cluster on each of three dedicated laptops',
  'Never join them into one Kubernetes cluster over the WAN',
  'loss of **one** laptop/site',
  'asymmetric private-mesh partition',
]) {
  if (!productionDoc.includes(phrase)) fail(`production boundary missing required statement: ${phrase}`);
}

const requiredScenarios = new Set([
  'follower-laptop-power-loss',
  'fiducia-leader-power-loss',
  'primary-wan-loss',
  'asymmetric-mesh-partition',
  'fiducia-member-stop',
  'replacement-laptop-rejoin',
  'seven-day-soak',
]);
const scenarioIds = new Set((campaign.scenarios || []).map((scenario) => scenario.id));
for (const id of requiredScenarios) {
  if (!scenarioIds.has(id)) fail(`acceptance campaign is missing scenario ${id}`);
}
if ((campaign.minimumSoakHours || 0) < 168) fail('physical soak requirement must be at least seven days');
if ((campaign.maxDuplicateProtectedMutations ?? 1) !== 0) fail('duplicate protected mutations must have zero tolerance');
if ((campaign.maxAcknowledgedMessageLoss ?? 1) !== 0) fail('acknowledged message loss must have zero tolerance');

console.log(JSON.stringify({
  linearIssue: 'DEN-3008',
  sourceDir,
  clusters: expected,
  requiredScenarios: [...requiredScenarios],
  result: 'PASS',
}, null, 2));
