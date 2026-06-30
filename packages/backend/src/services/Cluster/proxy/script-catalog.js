/**
 * script-catalog.js — Native Helper-Scripts Catalog API (ported from ProxLab)
 *
 * Replaces the ProxLab-bridged /api/script-catalog endpoints with a native
 * AI-Lab router. Ported 1:1 from ProxLab's /root/dv-lab/src/routes/script-catalog.js
 * (createScriptCatalogRouter(pveApi, sshService)).
 *
 * Serves the community-scripts + ProxLab installer catalog: parses ct/*.sh
 * files for APP / var_* metadata, enriches with archive JSON, resolves selfhst
 * CDN icons, indexes categories, and git-syncs the upstream repos on a timer.
 * Also serves the var_* form schema, per-app + global install defaults, and
 * live cluster data (storages / SSH keys / timezones) for the install form.
 *
 * Request/response shapes are preserved EXACTLY so the AI-Lab ScriptCatalogStore
 * (packages/ui/src/renderer_v2/stores/ScriptCatalogStore.ts) consumes them
 * unchanged (CatalogScript / Catalog / SchemaField / ClusterData / ScriptDefaults).
 *
 * ── ProxLab → AI-Lab adaptations ──────────────────────────────────────────
 *   - All persisted paths move from ProxLab's process.cwd()/data + src tree to
 *     <dataDir> (see the path block inside the factory). Repos git-clone under
 *     <dataDir>/script-repos exactly as before — AI-Lab (CT 152) has internet.
 *   - community-json (description/logo/website enrichment) and the ProxLab
 *     JSON dir are OPTIONAL seed datasets; absent dirs degrade gracefully
 *     (catalog still builds from the parsed ct/*.sh metadata) — identical to
 *     the original's existsSync guards.
 *   - The DELETE /defaults/:slug handler uses a top-level `unlinkSync` import
 *     instead of ProxLab's CommonJS `require('fs')` (this file runs as ESM).
 *
 * Dependency injection (constructed by UniversalProxyService):
 *   - pveApi  : PveApi instance (llmPve) — node map + per-node storage listing
 *   - sshExec : (host, cmd, { timeout? }) => Promise<{ code, stdout, stderr }>
 *   - dataDir : absolute path to the proxy data dir (cache + repos + defaults)
 *
 * @module proxy/script-catalog
 */

import { Router } from 'express';
import { execSync } from 'child_process';
import {
  readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, unlinkSync,
} from 'fs';
import { join, basename } from 'path';

const COMMUNITY_REPO = 'https://github.com/community-scripts/ProxmoxVE.git';
const PROXLAB_REPO = 'https://github.com/travisfinch1983/proxlab-helper-scripts.git';
const CACHE_TTL = 3600 * 1000; // 1 hour (on-demand freshness window)

// Category mapping — maps tags to display categories
const CATEGORY_MAP = {
  'database': { name: 'Databases', icon: 'database', order: 1 },
  'vector': { name: 'Vector Databases', icon: 'brain', order: 2 },
  'ai': { name: 'AI / Coding & Dev-Tools', icon: 'cpu', order: 3 },
  'docker': { name: 'Containers & Docker', icon: 'box', order: 4 },
  'smarthome': { name: 'IoT & Smart Home', icon: 'home', order: 5 },
  'zigbee': { name: 'ZigBee, Z-Wave & Matter', icon: 'radio', order: 6 },
  'zwave': { name: 'ZigBee, Z-Wave & Matter', icon: 'radio', order: 6 },
  'matter': { name: 'ZigBee, Z-Wave & Matter', icon: 'radio', order: 6 },
  'mqtt': { name: 'MQTT & Messaging', icon: 'message-square', order: 7 },
  'automation': { name: 'Automation & Scheduling', icon: 'zap', order: 8 },
  'monitoring': { name: 'Monitoring & Analytics', icon: 'activity', order: 9 },
  'analytics': { name: 'Monitoring & Analytics', icon: 'activity', order: 9 },
  'dashboard': { name: 'Dashboards & Frontends', icon: 'layout', order: 10 },
  'dns': { name: 'Adblock & DNS', icon: 'shield', order: 11 },
  'adblock': { name: 'Adblock & DNS', icon: 'shield', order: 11 },
  'network': { name: 'Network & Firewall', icon: 'globe', order: 12 },
  'networking': { name: 'Network & Firewall', icon: 'globe', order: 12 },
  'vpn': { name: 'Network & Firewall', icon: 'globe', order: 12 },
  'proxy': { name: 'Webservers & Proxies', icon: 'server', order: 13 },
  'webserver': { name: 'Webservers & Proxies', icon: 'server', order: 13 },
  'nginx': { name: 'Webservers & Proxies', icon: 'server', order: 13 },
  'media': { name: 'Media & Streaming', icon: 'film', order: 14 },
  'streaming': { name: 'Media & Streaming', icon: 'film', order: 14 },
  'arr': { name: '*Arr Suite', icon: 'download', order: 15 },
  'nvr': { name: 'NVR & Cameras', icon: 'camera', order: 16 },
  'backup': { name: 'Backup & Recovery', icon: 'save', order: 17 },
  'files': { name: 'Files & Downloads', icon: 'folder', order: 18 },
  'file-sharing': { name: 'Files & Downloads', icon: 'folder', order: 18 },
  'documents': { name: 'Documents & Notes', icon: 'file-text', order: 19 },
  'notes': { name: 'Documents & Notes', icon: 'file-text', order: 19 },
  'wiki': { name: 'Documents & Notes', icon: 'file-text', order: 19 },
  'auth': { name: 'Authentication & Security', icon: 'lock', order: 20 },
  'security': { name: 'Authentication & Security', icon: 'lock', order: 20 },
  'finance': { name: 'Finance & Budgeting', icon: 'dollar-sign', order: 21 },
  'gaming': { name: 'Gaming & Leisure', icon: 'gamepad-2', order: 22 },
  'business': { name: 'Business & ERP', icon: 'briefcase', order: 23 },
  'erp': { name: 'Business & ERP', icon: 'briefcase', order: 23 },
  'proxmox': { name: 'Proxmox & Virtualization', icon: 'server', order: 24 },
  'os': { name: 'Operating Systems', icon: 'terminal', order: 25 },
};

/**
 * Icon name resolution — maps script slugs to selfhst icon names
 */
const ICON_CDN = 'https://cdn.jsdelivr.net/gh/selfhst/icons@main/webp';
let iconNamesCache = null;

function loadIconNames() {
  if (iconNamesCache) return iconNamesCache;
  try {
    const raw = execSync(
      'curl -sf "https://api.github.com/repos/selfhst/icons/git/trees/main?recursive=1"',
      { timeout: 15000 }
    ).toString();
    const data = JSON.parse(raw);
    iconNamesCache = new Set(
      (data.tree || [])
        .filter(t => t.path.startsWith('webp/') && t.path.endsWith('.webp'))
        .map(t => t.path.replace('webp/', '').replace('.webp', ''))
    );
    console.log(`[script-catalog] Loaded ${iconNamesCache.size} icon names`);
  } catch (e) {
    console.warn('[script-catalog] Failed to load icon names:', e.message);
    iconNamesCache = new Set();
  }
  return iconNamesCache;
}

function resolveIconUrl(slug, appName) {
  if (!iconNamesCache || iconNamesCache.size === 0) {
    return `${ICON_CDN}/${slug}.webp`;
  }

  const nameLower = (appName || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  // Try in order of specificity
  const candidates = [
    slug,                                    // exact slug
    nameLower,                               // app name as-is
    slug.replace(/^alpine-/, ''),            // strip alpine- prefix
    slug.replace(/-/g, ''),                  // no hyphens
    nameLower.replace(/-/g, ''),             // name no hyphens
    slug.split('-')[0],                      // first word of slug
  ];

  for (const c of candidates) {
    if (iconNamesCache.has(c)) return `${ICON_CDN}/${c}.webp`;
  }

  // Try partial match — find an icon that contains the slug or vice versa
  for (const icon of iconNamesCache) {
    if (icon.length > 2 && slug.length > 2) {
      if (icon.includes(slug) || slug.includes(icon)) {
        return `${ICON_CDN}/${icon}.webp`;
      }
    }
  }

  // No match — return slug-based URL (will fall back to letter icon in frontend)
  return `${ICON_CDN}/${slug}.webp`;
}

/**
 * Parse a ct/*.sh script file to extract metadata.
 * @param {string} filePath  absolute path to the ct/*.sh file
 * @param {string} source    'community' | 'proxlab'
 * @param {string} reposDir  the script-repos dir (for ProxLab icon lookup)
 */
function parseCtScript(filePath, source, reposDir) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    const get = (varName) => {
      const re = new RegExp(`${varName}="?\\$\\{${varName}:-(.*?)\\}"?`);
      for (const line of lines) {
        const m = line.match(re);
        if (m) return m[1].replace(/[}"]/g, '');
      }
      return null;
    };

    const appMatch = content.match(/^APP="(.+?)"/m);
    if (!appMatch) return null;

    const name = appMatch[1];
    const slug = basename(filePath, '.sh').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const tags = (get('var_tags') || '').split(';').filter(Boolean);
    const sourceUrl = content.match(/# Source: (.+)/)?.[1] || '';
    const author = content.match(/# Author: (.+)/)?.[1] || '';

    // Determine display categories from tags
    const categories = [];
    const seenCats = new Set();
    for (const tag of tags) {
      const cat = CATEGORY_MAP[tag.toLowerCase()];
      if (cat && !seenCats.has(cat.name)) {
        categories.push(cat.name);
        seenCats.add(cat.name);
      }
    }
    if (categories.length === 0) categories.push('Miscellaneous');

    // Resolve icon — ProxLab scripts use our own hosted icons, community uses selfhst CDN
    let logo;
    if (source === 'proxlab') {
      // Check if we have an icon in the proxlab helper-scripts repo
      const proxlabIconDir = join(reposDir, 'proxlab', 'icons');
      const iconFile = ['png', 'webp', 'svg', 'jpg']
        .map(ext => ({ ext, path: join(proxlabIconDir, `${slug}.${ext}`) }))
        .find(f => existsSync(f.path));
      if (iconFile) {
        logo = `https://raw.githubusercontent.com/travisfinch1983/proxlab-helper-scripts/main/icons/${slug}.${iconFile.ext}`;
      } else {
        logo = resolveIconUrl(slug, name);
      }
    } else {
      logo = resolveIconUrl(slug, name);
    }

    return {
      name,
      slug,
      description: '', // CT scripts don't have descriptions — filled from JSON if available
      tags,
      categories,
      logo,
      source,
      sourceUrl,
      author,
      type: 'ct',
      resources: {
        cpu: parseInt(get('var_cpu') || '1'),
        ram: parseInt(get('var_ram') || '1024'),
        disk: parseInt(get('var_disk') || '4'),
        os: get('var_os') || 'debian',
        version: get('var_version') || '13',
      },
      privileged: get('var_unprivileged') === '0',
      installUrl: source === 'community'
        ? `https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/${basename(filePath)}`
        : `https://raw.githubusercontent.com/travisfinch1983/proxlab-helper-scripts/main/ct/${basename(filePath)}`,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Enrich community scripts with data from the frontend archive JSON files
 */
function enrichWithCommunityJson(script, jsonDir) {
  if (!existsSync(jsonDir)) return script;

  // Try exact slug match, then slug without alpine- prefix
  const candidates = [script.slug, script.slug.replace(/^alpine-/, '')];
  for (const slug of candidates) {
    const jsonPath = join(jsonDir, `${slug}.json`);
    if (!existsSync(jsonPath)) continue;

    try {
      const json = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      return {
        ...script,
        description: json.description || script.description,
        logo: json.logo || script.logo,
        website: json.website || script.website || '',
        documentation: json.documentation || script.documentation || '',
        interfacePort: json.interface_port || null,
        notes: json.notes || [],
        defaultCredentials: json.default_credentials || null,
      };
    } catch {
      continue;
    }
  }
  return script;
}

/**
 * Enrich script metadata with JSON data (for ProxLab scripts)
 */
function enrichWithJson(script, jsonDir) {
  const jsonPath = join(jsonDir, `${script.slug}.json`);
  if (!existsSync(jsonPath)) return script;

  try {
    const json = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    return {
      ...script,
      description: json.description || script.description,
      logo: json.logo || script.logo,
      website: json.website || '',
      documentation: json.documentation || '',
      interfacePort: json.interface_port || json.interfacePort || null,
      notes: json.notes || [],
      options: json.options || [],
      defaultCredentials: json.default_credentials || null,
    };
  } catch {
    return script;
  }
}

/**
 * Clone or pull a git repo
 */
function syncRepo(url, localDir) {
  try {
    if (existsSync(join(localDir, '.git'))) {
      execSync(`git -C "${localDir}" pull --ff-only 2>&1`, { timeout: 30000 });
    } else {
      mkdirSync(localDir, { recursive: true });
      execSync(`git clone --depth 1 "${url}" "${localDir}" 2>&1`, { timeout: 60000 });
    }
    return true;
  } catch (e) {
    console.error(`[script-catalog] Failed to sync ${url}:`, e.message);
    return false;
  }
}

// Allowed var_* keys and their display metadata (form schema)
const VAR_SCHEMA = [
  { key: 'var_cpu', label: 'CPU Cores', type: 'slider', min: 1, max: 32, step: 1, group: 'Resources', default: '1' },
  { key: 'var_ram', label: 'RAM (MB)', type: 'slider', min: 1024, max: 65536, step: 1024, group: 'Resources', default: '1024' },
  { key: 'var_disk', label: 'Disk (GB)', type: 'slider', min: 1, max: 500, step: 1, group: 'Resources', default: '4' },
  { key: 'var_os', label: 'OS', type: 'readonly', group: 'Resources', default: 'debian' },
  { key: 'var_version', label: 'OS Version', type: 'readonly', group: 'Resources', default: '13' },
  { key: 'var_unprivileged', label: 'Container Type', type: 'radio', options: [{ value: '1', label: 'Unprivileged' }, { value: '0', label: 'Privileged' }], group: 'Container', default: '1' },
  { key: 'var_hostname', label: 'Hostname', type: 'text', group: 'Container', default: '' },
  { key: 'var_tags', label: 'Tags', type: 'text', group: 'Container', default: 'community-script' },
  { key: 'var_protection', label: 'Protection', type: 'checkbox', trueVal: 'yes', falseVal: 'no', group: 'Container', default: 'no' },
  { key: 'var_timezone', label: 'Timezone', type: 'timezone', group: 'Container', default: '' },
  { key: 'var_brg', label: 'Bridge', type: 'text', group: 'Network', default: 'vmbr0' },
  { key: 'var_net', label: 'IP', type: 'text', group: 'Network', default: 'dhcp' },
  { key: 'var_gateway', label: 'Gateway', type: 'text', group: 'Network', default: '' },
  { key: 'var_vlan', label: 'VLAN', type: 'text', group: 'Network', default: '' },
  { key: 'var_mtu', label: 'MTU', type: 'text', group: 'Network', default: '' },
  { key: 'var_mac', label: 'MAC Address', type: 'text', group: 'Network', default: '' },
  { key: 'var_ns', label: 'DNS Server', type: 'text', group: 'Network', default: '' },
  { key: 'var_ipv6_method', label: 'IPv6 Method', type: 'select', options: ['auto', 'dhcp', 'static', 'none', 'disable'], group: 'Network', default: 'auto' },
  { key: 'var_ssh', label: 'Enable SSH', type: 'checkbox', trueVal: 'yes', falseVal: 'no', group: 'SSH', default: 'no' },
  { key: 'var_ssh_authorized_key', label: 'SSH Authorized Key', type: 'sshkeys', group: 'SSH', default: '' },
  { key: 'var_pw', label: 'Root Password', type: 'password', group: 'SSH', default: '' },
  { key: 'var_apt_cacher', label: 'APT Cacher', type: 'checkbox', trueVal: 'yes', falseVal: 'no', group: 'APT', default: 'no' },
  { key: 'var_apt_cacher_ip', label: 'APT Cacher IP', type: 'text', group: 'APT', default: '' },
  { key: 'var_nesting', label: 'Nesting', type: 'checkbox', trueVal: '1', falseVal: '0', group: 'Features', default: '1' },
  { key: 'var_fuse', label: 'FUSE', type: 'checkbox', trueVal: 'yes', falseVal: 'no', group: 'Features', default: 'no' },
  { key: 'var_tun', label: 'TUN', type: 'checkbox', trueVal: 'yes', falseVal: 'no', group: 'Features', default: 'no' },
  { key: 'var_gpu', label: 'GPU Passthrough', type: 'checkbox', trueVal: 'yes', falseVal: 'no', group: 'Features', default: 'no' },
  { key: 'var_keyctl', label: 'Keyctl', type: 'checkbox', trueVal: '1', falseVal: '0', group: 'Features', default: '0' },
  { key: 'var_mknod', label: 'Mknod', type: 'checkbox', trueVal: '1', falseVal: '0', group: 'Features', default: '0' },
  { key: 'var_mount_fs', label: 'Mount Filesystems', type: 'multicheck', options: ['nfs', 'cifs', 'fuse', 'ext4', 'xfs', 'btrfs'], group: 'Features', default: '' },
  { key: 'var_verbose', label: 'Verbose', type: 'checkbox', trueVal: 'yes', falseVal: 'no', group: 'Features', default: 'no' },
  { key: 'var_container_storage', label: 'Container Storage', type: 'node-storage', contentFilter: 'rootdir', group: 'Storage', default: '' },
  { key: 'var_template_storage', label: 'Template Storage', type: 'node-storage', contentFilter: 'vztmpl', group: 'Storage', default: '' },
];

export function createScriptCatalogRouter({ pveApi, sshExec, dataDir }) {
  const router = Router();

  // ─── Persisted paths (all under dataDir) ────────────────────────────────
  const DATA_DIR = join(dataDir);
  const CACHE_FILE = join(dataDir, 'script-catalog-cache.json');
  const REPOS_DIR = join(dataDir, 'script-repos');
  const COMMUNITY_JSON_DIR = join(dataDir, 'community-json'); // optional enrichment seed
  const PROXLAB_JSON_DIR = join(dataDir, 'install-scripts');  // optional enrichment seed (chromadb/milvus/…)
  const DEFAULTS_FILE = join(dataDir, 'script-global-defaults.json');
  const APP_DEFAULTS_DIR = join(dataDir, 'script-app-defaults');

  /** Build the full catalog from both repos */
  function buildCatalog() {
    // Load icon names for fuzzy matching
    loadIconNames();

    const communityDir = join(REPOS_DIR, 'community');
    const proxlabDir = join(REPOS_DIR, 'proxlab');

    // Sync repos
    syncRepo(COMMUNITY_REPO, communityDir);
    syncRepo(PROXLAB_REPO, proxlabDir);

    const scripts = [];

    // Parse community scripts and enrich with frontend archive JSON
    const communityCtDir = join(communityDir, 'ct');
    if (existsSync(communityCtDir)) {
      for (const file of readdirSync(communityCtDir)) {
        if (!file.endsWith('.sh')) continue;
        let script = parseCtScript(join(communityCtDir, file), 'community', REPOS_DIR);
        if (script) {
          // Enrich with description, logo, website, docs from archive JSON
          script = enrichWithCommunityJson(script, COMMUNITY_JSON_DIR);
          scripts.push(script);
        }
      }
    }

    // Parse ProxLab scripts
    const proxlabCtDir = join(proxlabDir, 'ct');
    if (existsSync(proxlabCtDir)) {
      for (const file of readdirSync(proxlabCtDir)) {
        if (!file.endsWith('.sh')) continue;
        const script = parseCtScript(join(proxlabCtDir, file), 'proxlab', REPOS_DIR);
        if (script) {
          // Enrich with JSON metadata if available
          const enriched = enrichWithJson(script, PROXLAB_JSON_DIR);
          scripts.push(enriched);
        }
      }
    }

    // Sort: ProxLab scripts first, then alphabetical
    scripts.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'proxlab' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // Build category index
    const categoryIndex = {};
    for (const script of scripts) {
      for (const cat of script.categories) {
        if (!categoryIndex[cat]) categoryIndex[cat] = 0;
        categoryIndex[cat]++;
      }
    }

    const catalog = {
      scripts,
      categories: Object.entries(categoryIndex)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => {
          const orderA = Object.values(CATEGORY_MAP).find(c => c.name === a.name)?.order || 99;
          const orderB = Object.values(CATEGORY_MAP).find(c => c.name === b.name)?.order || 99;
          return orderA - orderB;
        }),
      totalScripts: scripts.length,
      lastSync: new Date().toISOString(),
    };

    // Cache to disk
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify(catalog));
    } catch {}

    return catalog;
  }

  /** Get catalog (from cache or build fresh) */
  function getCatalog(forceRefresh = false) {
    if (!forceRefresh && existsSync(CACHE_FILE)) {
      try {
        const cached = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
        const age = Date.now() - new Date(cached.lastSync).getTime();
        if (age < CACHE_TTL) return cached;
      } catch {}
    }
    return buildCatalog();
  }

  // Sync status tracking (shared state for progress reporting)
  let syncStatus = { running: false, step: 'Not started', progress: 0, error: null };

  // GET /api/script-catalog — Full catalog
  router.get('/', (req, res) => {
    try {
      const catalog = getCatalog();
      const { category, search, source, tag } = req.query;

      let scripts = catalog.scripts;

      // Filter by category
      if (category) {
        scripts = scripts.filter(s => s.categories.includes(category));
      }

      // Filter by source
      if (source) {
        scripts = scripts.filter(s => s.source === source);
      }

      // Filter by tag
      if (tag) {
        scripts = scripts.filter(s => s.tags.includes(tag.toLowerCase()));
      }

      // Search
      if (search) {
        const q = search.toLowerCase();
        scripts = scripts.filter(s =>
          s.name.toLowerCase().includes(q) ||
          s.slug.includes(q) ||
          s.tags.some(t => t.includes(q)) ||
          (s.description || '').toLowerCase().includes(q)
        );
      }

      res.json({
        scripts,
        categories: catalog.categories,
        totalScripts: catalog.totalScripts,
        lastSync: catalog.lastSync,
        filtered: scripts.length,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/script-catalog/categories — Category list
  router.get('/categories', (req, res) => {
    try {
      const catalog = getCatalog();
      res.json(catalog.categories);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/script-catalog/sync/status — Check sync progress
  router.get('/sync/status', (req, res) => {
    res.json(syncStatus);
  });

  // POST /api/script-catalog/sync — Force re-sync (async)
  router.post('/sync', async (req, res) => {
    if (syncStatus.running) {
      return res.json({ ok: true, message: 'Sync already in progress', ...syncStatus });
    }

    syncStatus = { running: true, step: 'Starting sync...', progress: 0, error: null };
    res.json({ ok: true, message: 'Sync started' });

    // Run sync in background
    try {
      syncStatus.step = 'Cloning community-scripts repository...';
      syncStatus.progress = 10;
      const communityDir = join(REPOS_DIR, 'community');
      syncRepo(COMMUNITY_REPO, communityDir);

      syncStatus.step = 'Cloning ProxLab helper-scripts repository...';
      syncStatus.progress = 40;
      const proxlabDir = join(REPOS_DIR, 'proxlab');
      syncRepo(PROXLAB_REPO, proxlabDir);

      syncStatus.step = 'Parsing script metadata...';
      syncStatus.progress = 70;
      const catalog = buildCatalog();

      syncStatus = {
        running: false,
        step: 'Complete',
        progress: 100,
        error: null,
        totalScripts: catalog.totalScripts,
        lastSync: catalog.lastSync,
      };
    } catch (e) {
      syncStatus = { running: false, step: 'Failed', progress: 0, error: e.message };
    }
  });

  // Auto-sync on startup (background, don't block server start)
  setTimeout(() => {
    if (!existsSync(CACHE_FILE)) {
      console.log('[script-catalog] No cache found, starting initial sync...');
      syncStatus = { running: true, step: 'Initial sync — cloning repositories...', progress: 5, error: null };
      try {
        buildCatalog();
        syncStatus = { running: false, step: 'Complete', progress: 100, error: null };
        console.log('[script-catalog] Initial sync complete');
      } catch (e) {
        syncStatus = { running: false, step: 'Failed', progress: 0, error: e.message };
        console.error('[script-catalog] Initial sync failed:', e.message);
      }
    }
  }, 5000);

  // Periodic re-sync every 6 hours
  setInterval(() => {
    if (!syncStatus.running) {
      console.log('[script-catalog] Periodic re-sync starting...');
      syncStatus = { running: true, step: 'Periodic sync...', progress: 10, error: null };
      try {
        buildCatalog();
        syncStatus = { running: false, step: 'Complete', progress: 100, error: null };
        console.log('[script-catalog] Periodic re-sync complete');
      } catch (e) {
        syncStatus = { running: false, step: 'Failed', progress: 0, error: e.message };
      }
    }
  }, 6 * 3600 * 1000);

  // ═══════════════════════════════════════════════════════════════════════════
  // DYNAMIC DATA — Storage, SSH keys, Timezones from PVE cluster
  // ═══════════════════════════════════════════════════════════════════════════

  // Cached cluster data — refreshed every 5 minutes in background
  let clusterDataCache = null;
  let clusterDataRefreshing = false;

  async function refreshClusterData() {
    if (clusterDataRefreshing) return;
    clusterDataRefreshing = true;
    try {
      const nodeMap = pveApi ? pveApi.getNodeMap() : {};
      const onlineNodes = Object.entries(nodeMap)
        .filter(([, info]) => info.online && info.ip)
        .map(([name, info]) => ({ name, ip: info.ip }));

      // Fetch storages per node via PVE API
      const storagesByNode = {};
      if (pveApi) {
        for (const node of onlineNodes) {
          try {
            const resp = await pveApi.request(`/nodes/${node.name}/storage`);
            const storages = resp?.data || resp || [];
            storagesByNode[node.name] = (Array.isArray(storages) ? storages : [])
              .filter(s => s.active && s.enabled)
              .map(s => ({
                storage: s.storage,
                type: s.type,
                content: s.content || '',
                shared: !!s.shared,
              }));
          } catch { storagesByNode[node.name] = []; }
        }
      }

      // Fetch SSH authorized keys from first online node
      let sshKeys = [];
      if (sshExec && onlineNodes.length > 0) {
        try {
          const result = await sshExec(onlineNodes[0].ip, 'cat /root/.ssh/authorized_keys 2>/dev/null', { timeout: 5000 });
          const raw = result.stdout || result || '';
          sshKeys = raw.toString().split('\n')
            .filter(line => line.trim() && !line.startsWith('#'))
            .map(line => {
              const parts = line.trim().split(/\s+/);
              const type = parts[0] || '';
              const key = parts[1] || '';
              const comment = parts.slice(2).join(' ') || 'unnamed key';
              const fingerprint = key.substring(0, 20) + '...';
              return { type, fingerprint, comment, full: line.trim() };
            });
        } catch {}
      }

      // Fetch timezones from first online node (only once — timezones don't change)
      let timezones = clusterDataCache?.timezones || [];
      if (timezones.length === 0 && sshExec && onlineNodes.length > 0) {
        try {
          const result = await sshExec(onlineNodes[0].ip, 'timedatectl list-timezones 2>/dev/null', { timeout: 5000 });
          const raw = result.stdout || result || '';
          timezones = raw.toString().split('\n').filter(Boolean);
        } catch {}
      }

      clusterDataCache = { nodes: onlineNodes, storagesByNode, sshKeys, timezones, lastRefresh: new Date().toISOString() };
      console.log(`[cluster-data] Refreshed: ${onlineNodes.length} nodes, ${sshKeys.length} keys, ${Object.values(storagesByNode).flat().length} storages`);
    } catch (e) {
      console.error('[cluster-data] Refresh failed:', e.message);
    } finally {
      clusterDataRefreshing = false;
    }
  }

  // Initial fetch 10s after startup, then every 5 minutes
  setTimeout(() => refreshClusterData(), 10000);
  setInterval(() => refreshClusterData(), 5 * 60 * 1000);

  // GET /api/script-catalog/cluster-data — Serves cached data instantly
  router.get('/cluster-data', (req, res) => {
    if (clusterDataCache) {
      res.json(clusterDataCache);
    } else {
      // First request before cache is ready — trigger immediate refresh
      refreshClusterData().then(() => {
        res.json(clusterDataCache || { nodes: [], storagesByNode: {}, sshKeys: [], timezones: [] });
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DEFAULTS MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  function loadDefaults() {
    try {
      if (existsSync(DEFAULTS_FILE)) return JSON.parse(readFileSync(DEFAULTS_FILE, 'utf-8'));
    } catch {}
    return {};
  }

  function saveDefaults(data) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DEFAULTS_FILE, JSON.stringify(data, null, 2));
  }

  function loadAppDefaults(slug) {
    try {
      const p = join(APP_DEFAULTS_DIR, `${slug}.json`);
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {}
    return {};
  }

  function saveAppDefaults(slug, data) {
    mkdirSync(APP_DEFAULTS_DIR, { recursive: true });
    writeFileSync(join(APP_DEFAULTS_DIR, `${slug}.json`), JSON.stringify(data, null, 2));
  }

  // GET /api/script-catalog/defaults/schema — Variable schema for form rendering
  router.get('/defaults/schema', (req, res) => {
    res.json(VAR_SCHEMA);
  });

  // GET /api/script-catalog/defaults — Global defaults
  router.get('/defaults', (req, res) => {
    res.json(loadDefaults());
  });

  // PUT /api/script-catalog/defaults — Save global defaults
  router.put('/defaults', (req, res) => {
    try {
      saveDefaults(req.body || {});
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/script-catalog/defaults/:slug — App-specific defaults
  router.get('/defaults/:slug', (req, res) => {
    const appDefs = loadAppDefaults(req.params.slug);
    const globalDefs = loadDefaults();
    res.json({
      global: globalDefs,
      app: appDefs,
      hasGlobal: Object.keys(globalDefs).length > 0,
      hasApp: Object.keys(appDefs).length > 0,
    });
  });

  // PUT /api/script-catalog/defaults/:slug — Save app-specific defaults
  router.put('/defaults/:slug', (req, res) => {
    try {
      saveAppDefaults(req.params.slug, req.body || {});
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/script-catalog/defaults/:slug — Remove app-specific defaults
  router.delete('/defaults/:slug', (req, res) => {
    try {
      const p = join(APP_DEFAULTS_DIR, `${req.params.slug}.json`);
      if (existsSync(p)) {
        unlinkSync(p);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/script-catalog/defaults/generate-command — Generate var_* command prefix
  router.post('/defaults/generate-command', (req, res) => {
    const { slug, overrides } = req.body || {};
    const globalDefs = loadDefaults();
    const appDefs = slug ? loadAppDefaults(slug) : {};

    // Merge: script defaults < global < app < overrides
    const merged = { ...globalDefs, ...appDefs, ...(overrides || {}) };

    // Build var_* prefix string
    const parts = ['mode=generated'];
    for (const [key, val] of Object.entries(merged)) {
      if (key.startsWith('var_') && val !== '' && val !== undefined && val !== null) {
        parts.push(`${key}="${String(val).replace(/"/g, '\\"')}"`);
      }
    }

    res.json({
      prefix: parts.join(' '),
      vars: merged,
    });
  });

  // GET /api/script-catalog/:slug — Single script
  // IMPORTANT: This must be LAST — it's a wildcard that catches everything
  router.get('/:slug', (req, res) => {
    try {
      const catalog = getCatalog();
      const script = catalog.scripts.find(s => s.slug === req.params.slug);
      if (!script) return res.status(404).json({ error: 'Script not found' });
      res.json(script);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
