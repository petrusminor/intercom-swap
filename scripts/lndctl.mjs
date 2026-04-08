#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const MAINNET_NEUTRINO_FEE_URL = 'https://nodes.lightning.computer/fees/v1/btc-fee-estimates.json';
const MAINNET_NEUTRINO_DEFAULT_PEERS = [
  '165.227.7.29:8333',
  '45.79.195.29:8333',
  '154.53.63.218:8333',
  '91.134.145.202:8333',
  '65.109.145.24:8333',
];
const MAINNET_NEUTRINO_PEER_IP_MAP = new Map([
  ['btcd-mainnet.lightning.computer', '165.227.7.29'],
  ['btcd1.lnolymp.us', '45.79.195.29'],
  ['btcd2.lnolymp.us', '154.53.63.218'],
  ['bb1.breez.technology', '91.134.145.202'],
  ['bb2.breez.technology', '65.109.145.24'],
  ['neutrino.shock.network', '167.88.11.203'],
  ['uswest.blixtwallet.com', '45.137.194.104'],
]);
const execFileP = promisify(execFile);

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function usage() {
  return `
lndctl (LND lifecycle + config helper; neutrino recommended for mainnet)

Commands:
  init --node <name> [--network <mainnet|testnet|signet|regtest>] [--lnd-dir <path>]
       [--alias <str>] [--p2p-port <n>] [--rpc-port <n>] [--rest-port <n>]
       [--bitcoin-node <neutrino|bitcoind>] [--neutrino-peers <host:port[,..]>]
       [--wallet-password-file <path>]

  start --node <name> [--network <mainnet|testnet|signet|regtest>] [--lnd-dir <path>] [--lnd-bin <path>]

  stop --node <name> [--network <mainnet|testnet|signet|regtest>] [--lnd-dir <path>] [--lncli-bin <path>]

  create-wallet --node <name> [--network <mainnet|testnet|signet|regtest>] [--lnd-dir <path>] [--lncli-bin <path>]
    Runs \`lncli create\` (interactive). Do NOT use --noseedbackup on mainnet.

  unlock --node <name> [--network <mainnet|testnet|signet|regtest>] [--lnd-dir <path>] [--lncli-bin <path>]
    Runs \`lncli unlock\` (interactive).

  paths --node <name> [--network <mainnet|testnet|signet|regtest>] [--lnd-dir <path>]

Notes:
  - Default lnd dir: onchain/lnd/<network>/<node> (gitignored).
  - For mainnet without bitcoind, set --bitcoin-node neutrino and provide --neutrino-peers.
  - To run unattended, set --wallet-password-file in the config (store it under onchain/; keep perms tight).
`.trim();
}

function parseArgs(argv) {
  const args = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) flags.set(key, true);
      else {
        flags.set(key, next);
        i += 1;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

function requireFlag(flags, name) {
  const v = flags.get(name);
  if (!v || v === true) die(`Missing --${name}`);
  return String(v);
}

function parseIntFlag(flags, name, fallback) {
  if (!flags.get(name)) return fallback;
  const n = Number.parseInt(String(flags.get(name)), 10);
  if (!Number.isFinite(n) || n <= 0) die(`Invalid --${name}`);
  return n;
}

function normalizeNetwork(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'mainnet';
  if (raw === 'mainnet' || raw === 'main' || raw === 'bitcoin' || raw === 'btc') return 'mainnet';
  if (raw === 'testnet' || raw === 'test') return 'testnet';
  if (raw === 'signet') return 'signet';
  if (raw === 'regtest' || raw === 'reg') return 'regtest';
  throw new Error(`Unsupported network: ${raw} (expected mainnet|testnet|signet|regtest)`);
}

function normalizeBitcoinNode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'neutrino';
  if (raw === 'neutrino') return 'neutrino';
  if (raw === 'bitcoind') return 'bitcoind';
  throw new Error(`Unsupported --bitcoin-node: ${raw} (expected neutrino|bitcoind)`);
}

function defaultDir({ network, node }) {
  return path.join(repoRoot, 'onchain', 'lnd', network, node);
}

function macaroonPathFor({ lndDir, network }) {
  // LND standard layout.
  return path.join(lndDir, 'data', 'chain', 'bitcoin', network, 'admin.macaroon');
}

function tlsCertPathFor({ lndDir }) {
  return path.join(lndDir, 'tls.cert');
}

function configPathFor({ lndDir }) {
  return path.join(lndDir, 'lnd.conf');
}

function resolveLncliRpcserver({ lndDir }) {
  const confPath = configPathFor({ lndDir });
  if (!fs.existsSync(confPath)) return '';
  try {
    return extractLndConfValue(fs.readFileSync(confPath, 'utf8'), 'rpclisten');
  } catch (_err) {
    return '';
  }
}

function writeFileAtomic(filePath, text, mode = null) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', ...(mode ? { mode } : {}) });
  fs.renameSync(tmp, filePath);
}

function splitCsv(value) {
  const s = String(value || '').trim();
  if (!s) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function warn(msg) {
  process.stderr.write(`Warning: ${msg}\n`);
}

function debugLncliCall({ rpcserver, lnddir, tlscertpath, command }) {
  process.stderr.write(
    `[lncli] command=${command} rpcserver=${rpcserver || ''} lnddir=${lnddir || ''} tlscertpath=${tlscertpath || ''}\n`
  );
}

function isIpv4Host(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(value || '').trim());
}

function normalizeNeutrinoPeers({ network, bitcoinNode, peers }) {
  if (network !== 'mainnet' || bitcoinNode !== 'neutrino') return peers;
  const source = Array.isArray(peers) && peers.length > 0 ? peers : MAINNET_NEUTRINO_DEFAULT_PEERS;
  const normalized = [];
  const seen = new Set();
  for (const rawPeer of source) {
    const peer = String(rawPeer || '').trim();
    if (!peer) continue;
    const m = peer.match(/^(.*):([0-9]+)$/);
    if (!m) {
      if (!seen.has(peer)) {
        seen.add(peer);
        normalized.push(peer);
      }
      continue;
    }
    const host = String(m[1] || '').trim();
    const port = String(m[2] || '').trim();
    const hostLower = host.toLowerCase();
    const outHost = isIpv4Host(hostLower) ? hostLower : (MAINNET_NEUTRINO_PEER_IP_MAP.get(hostLower) || host);
    const outPeer = `${outHost}:${port}`;
    if (!seen.has(outPeer)) {
      seen.add(outPeer);
      normalized.push(outPeer);
    }
  }
  return normalized;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractLndConfValue(confText, key) {
  const rx = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(.*?)\\s*$`, 'm');
  const match = String(confText || '').match(rx);
  return match ? String(match[1] || '').trim() : '';
}

function extractAllLndConfValues(confText, key) {
  const rx = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(.*?)\\s*$`, 'gm');
  const matches = [];
  for (const match of String(confText || '').matchAll(rx)) {
    matches.push(String(match[1] || '').trim());
  }
  return matches;
}

function collectMainnetNeutrinoWarnings(confPath) {
  let confText = '';
  try {
    confText = fs.readFileSync(confPath, 'utf8');
  } catch (err) {
    return [`Failed to read config: ${confPath} (${err?.message || String(err)})`];
  }
  const isMainnet = extractLndConfValue(confText, 'bitcoin.mainnet') === '1';
  const bitcoinNode = extractLndConfValue(confText, 'bitcoin.node');
  if (!isMainnet || bitcoinNode !== 'neutrino') return [];

  const warnings = [];
  const feeUrls = extractAllLndConfValues(confText, 'fee.url');
  if (feeUrls.length === 0) {
    warnings.push(`mainnet neutrino config missing fee.url=${MAINNET_NEUTRINO_FEE_URL}`);
  } else if (feeUrls.length > 1) {
    warnings.push(`mainnet neutrino config has duplicate fee.url entries in ${confPath}`);
  } else if (feeUrls[0] !== MAINNET_NEUTRINO_FEE_URL) {
    warnings.push(`mainnet neutrino config fee.url should be ${MAINNET_NEUTRINO_FEE_URL}`);
  }

  const peers = extractAllLndConfValues(confText, 'neutrino.addpeer');
  if (peers.length === 0) {
    warnings.push('mainnet neutrino config has no neutrino.addpeer entries');
  }
  for (const peer of peers) {
    const m = String(peer || '').trim().match(/^(.*):([0-9]+)$/);
    const host = m ? String(m[1] || '').trim() : '';
    if (host && !isIpv4Host(host)) {
      warnings.push(`neutrino peer ${peer} uses a hostname. Likely DNS issue (WSL). See SKILL.md LND section.`);
    }
  }
  return warnings;
}

function printMainnetNeutrinoWarnings(confPath) {
  for (const msg of collectMainnetNeutrinoWarnings(confPath)) warn(msg);
}

async function getLndInfo({ lncliBin, network, lndDir, cwd }) {
  const tlscertpath = tlsCertPathFor({ lndDir });
  debugLncliCall({
    command: 'getinfo',
    rpcserver: resolveLncliRpcserver({ lndDir }),
    lnddir: lndDir,
    tlscertpath,
  });
  const { stdout } = await execFileP(
    lncliBin,
    [`--network=${network}`, `--lnddir=${lndDir}`, `--tlscertpath=${tlscertpath}`, 'getinfo'],
    { cwd, maxBuffer: 1024 * 1024 * 4 }
  );
  return JSON.parse(String(stdout || '').trim() || '{}');
}

function scheduleLndHealthHints({ lncliBin, network, lndDir, cwd }) {
  if (network !== 'mainnet') return;
  const timer = setTimeout(async () => {
    try {
      const info = await getLndInfo({ lncliBin, network, lndDir, cwd });
      const syncedToChain = info?.synced_to_chain === true;
      const syncedToGraph = info?.synced_to_graph === true;
      const numPeers = Number(info?.num_peers || 0);
      if (numPeers === 0) {
        warn('LND is running with num_peers=0. Likely DNS issue (WSL). See SKILL.md LND section.');
      }
      if (!syncedToChain || !syncedToGraph || numPeers <= 0) {
        warn(
          `LND health check: synced_to_chain=${syncedToChain} synced_to_graph=${syncedToGraph} num_peers=${numPeers}. DO NOT RUN SWAPS UNTIL THESE ARE TRUE.`
        );
      }
    } catch (_err) {
      warn('LND health check unavailable after startup (node may still be locked). Run scripts/lnd-health.sh after unlock.');
    }
  }, 8000);
  if (typeof timer.unref === 'function') timer.unref();
}

function buildLndConf({
  network,
  alias,
  p2pPort,
  rpcPort,
  restPort,
  bitcoinNode,
  neutrinoPeers,
  walletPasswordFile,
}) {
  const lines = [];
  lines.push('[Application Options]');
  if (alias) lines.push(`alias=${alias}`);
  lines.push(`listen=0.0.0.0:${p2pPort}`);
  lines.push(`rpclisten=127.0.0.1:${rpcPort}`);
  lines.push(`restlisten=127.0.0.1:${restPort}`);
  lines.push('tlsextraip=127.0.0.1');
  lines.push('tlsextradomain=localhost');

  // Auto-unlock is optional and should be treated as a secret.
  if (walletPasswordFile) {
    lines.push(`wallet-unlock-password-file=${walletPasswordFile}`);
    lines.push('wallet-unlock-allow-create=1');
  }

  lines.push('');
  lines.push('[Bitcoin]');
  lines.push('bitcoin.active=1');
  if (network === 'mainnet') lines.push('bitcoin.mainnet=1');
  if (network === 'testnet') lines.push('bitcoin.testnet=1');
  if (network === 'signet') lines.push('bitcoin.signet=1');
  if (network === 'regtest') lines.push('bitcoin.regtest=1');
  lines.push(`bitcoin.node=${bitcoinNode}`);

  if (bitcoinNode === 'neutrino') {
    if (network === 'mainnet') {
      lines.push('');
      lines.push('[fee]');
      lines.push(`fee.url=${MAINNET_NEUTRINO_FEE_URL}`);
    }
    lines.push('');
    lines.push('[neutrino]');
    if (neutrinoPeers.length === 0) {
      lines.push('; NOTE: neutrino peers are recommended for reliability.');
      lines.push('; Add at least one peer that supports compact filters, e.g.:');
      lines.push('; neutrino.addpeer=<host:port>');
    } else {
      for (const peer of neutrinoPeers) lines.push(`neutrino.addpeer=${peer}`);
    }
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function run(cmd, args, { cwd, inheritStdio = true } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: inheritStdio ? 'inherit' : 'pipe',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function runLncli({ lncliBin, network, lndDir, command, extraArgs = [], cwd, inheritStdio = true }) {
  const tlscertpath = tlsCertPathFor({ lndDir });
  debugLncliCall({
    command,
    rpcserver: resolveLncliRpcserver({ lndDir }),
    lnddir: lndDir,
    tlscertpath,
  });
  const args = [`--network=${network}`, `--lnddir=${lndDir}`, `--tlscertpath=${tlscertpath}`, ...extraArgs];
  await run(lncliBin, args, { cwd, inheritStdio });
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const cmd = args[0] || '';
  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const node = flags.get('node') ? String(flags.get('node')).trim() : '';
  if (!node) die('Missing --node');
  const network = normalizeNetwork(flags.get('network') || 'mainnet');
  const lndDir = flags.get('lnd-dir') ? path.resolve(String(flags.get('lnd-dir'))) : defaultDir({ network, node });

  if (cmd === 'paths') {
    const conf = configPathFor({ lndDir });
    const tls = tlsCertPathFor({ lndDir });
    const mac = macaroonPathFor({ lndDir, network });
    process.stdout.write(`${JSON.stringify({
      type: 'paths',
      node,
      network,
      lnd_dir: lndDir,
      config: conf,
      tls_cert: tls,
      admin_macaroon: mac,
      rpcserver_default: '127.0.0.1:10009',
      p2p_default: '0.0.0.0:9735',
    }, null, 2)}\n`);
    return;
  }

  if (cmd === 'init') {
    const alias = flags.get('alias') ? String(flags.get('alias')).trim() : node;
    const p2pPort = parseIntFlag(flags, 'p2p-port', 9735);
    const rpcPort = parseIntFlag(flags, 'rpc-port', 10009);
    const restPort = parseIntFlag(flags, 'rest-port', 8080);
    const bitcoinNode = normalizeBitcoinNode(flags.get('bitcoin-node') || 'neutrino');
    const neutrinoPeers = normalizeNeutrinoPeers({
      network,
      bitcoinNode,
      peers: splitCsv(flags.get('neutrino-peers')),
    });
    if (network === 'mainnet' && bitcoinNode === 'neutrino') {
      for (const peer of neutrinoPeers) {
        const m = String(peer || '').trim().match(/^(.*):([0-9]+)$/);
        const host = m ? String(m[1] || '').trim() : '';
        if (host && !isIpv4Host(host)) {
          warn(`mainnet neutrino peer ${peer} uses a hostname. Likely DNS issue (WSL). See SKILL.md LND section.`);
        }
      }
    }
    const walletPasswordFile = flags.get('wallet-password-file')
      ? path.resolve(String(flags.get('wallet-password-file')))
      : '';

    const confText = buildLndConf({
      network,
      alias,
      p2pPort,
      rpcPort,
      restPort,
      bitcoinNode,
      neutrinoPeers,
      walletPasswordFile: walletPasswordFile || null,
    });

    const confPath = configPathFor({ lndDir });
    writeFileAtomic(confPath, confText);

    process.stdout.write(`${JSON.stringify({
      type: 'init',
      node,
      network,
      lnd_dir: lndDir,
      config: confPath,
      bitcoin_node: bitcoinNode,
      neutrino_peers: neutrinoPeers,
      rpcserver: `127.0.0.1:${rpcPort}`,
      restlisten: `127.0.0.1:${restPort}`,
      listen: `0.0.0.0:${p2pPort}`,
    }, null, 2)}\n`);
    return;
  }

  if (cmd === 'start') {
    const lndBin = flags.get('lnd-bin') ? String(flags.get('lnd-bin')).trim() : 'lnd';
    const lncliBin = flags.get('lncli-bin') ? String(flags.get('lncli-bin')).trim() : 'lncli';
    const confPath = configPathFor({ lndDir });
    if (!fs.existsSync(confPath)) die(`Missing config: ${confPath}. Run: lndctl init ...`);
    printMainnetNeutrinoWarnings(confPath);
    scheduleLndHealthHints({ lncliBin, network, lndDir, cwd: repoRoot });
    await run(lndBin, [`--lnddir=${lndDir}`, `--configfile=${confPath}`], { cwd: repoRoot, inheritStdio: true });
    return;
  }

  if (cmd === 'stop') {
    const lncliBin = flags.get('lncli-bin') ? String(flags.get('lncli-bin')).trim() : 'lncli';
    await runLncli({ lncliBin, network, lndDir, command: 'stop', extraArgs: ['stop'], cwd: repoRoot, inheritStdio: true });
    return;
  }

  if (cmd === 'create-wallet') {
    const lncliBin = flags.get('lncli-bin') ? String(flags.get('lncli-bin')).trim() : 'lncli';
    await runLncli({ lncliBin, network, lndDir, command: 'create', extraArgs: ['create'], cwd: repoRoot, inheritStdio: true });
    return;
  }

  if (cmd === 'unlock') {
    const lncliBin = flags.get('lncli-bin') ? String(flags.get('lncli-bin')).trim() : 'lncli';
    await runLncli({ lncliBin, network, lndDir, command: 'unlock', extraArgs: ['unlock'], cwd: repoRoot, inheritStdio: true });
    return;
  }

  die(`Unknown command: ${cmd}`);
}

main().catch((err) => die(err?.stack || err?.message || String(err)));
