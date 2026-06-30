/**
 * provider-installer.js — LLM Provider Install Orchestrator
 *
 * Manages installation, uninstallation, and status checks of LLM inference
 * providers across AI agent containers via SSH.
 *
 * Install scripts follow the ProxLab contract:
 *   - Arguments: install | uninstall | status
 *   - Env vars: PROXLAB_GPU_ARCHS, PROXLAB_GPU_VENDOR, PROXLAB_INSTALL_DIR
 *   - Output: PROXLAB_STATUS=installed|not_installed|error, PROXLAB_VERSION=x.y.z
 *
 * @module provider-installer
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getProvider } from './providers.js';
import { getClusterGpus } from './gpu-specs.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const gpuAssignFile = join(dataDir, 'gpu-assignments.json');

function loadGpuAssignments() {
  try {
    if (existsSync(gpuAssignFile)) return JSON.parse(readFileSync(gpuAssignFile, 'utf-8'));
  } catch {}
  return {};
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// Provider install/status/update scripts are runtime data under the proxy DATA_DIR
// (AILAB_PROXY_DATA_DIR, normally /opt/ai-lab/.gybackend-data/scripts) — they are NOT in the
// source tree. Resolving against the source dir (join(__dirname,'..','..')) pointed at
// .../Cluster/proxy/scripts/, which doesn't exist on deploy, so checkStatus/checkUpdate/install
// died with ENOENT reading the script → the endpoint never updated the cached provider version
// (the Provider Install tab kept showing the install-time version forever). Use the same
// env-based resolver as ai.js/hf-download.js so it finds the deployed scripts.
const DATA_DIR = process.env.AILAB_PROXY_DATA_DIR || join(__dirname, '..', '..', 'data');
const scriptsDir = join(DATA_DIR, 'scripts', 'providers');
const setupDir = join(DATA_DIR, 'scripts', 'setup');

export class ProviderInstaller {
  constructor({ sshService, pveApi, gpuMonitor }) {
    this.sshService = sshService;
    this.pveApi = pveApi;
    this.gpuMonitor = gpuMonitor;
  }

  /**
   * Get the IP address of an AI agent container.
   * @param {number} vmid - Container VMID
   * @returns {string|null} Container IP or null
   */
  getContainerIp(vmid) {
    const guest = this.pveApi.getGuests().find(g => g.vmid === vmid);
    return guest?.ip || null;
  }

  /**
   * Get the GPU architectures assigned to an agent container.
   * Filters to only GPUs in gpu-assignments.json for the agent's VMID.
   * @param {string} node - PVE node name
   * @param {number} vmid - Agent container VMID
   * @returns {string[]} Array of architecture names (e.g. ['Ada Lovelace'])
   */
  getAgentGpuArchs(node, vmid) {
    const inventory = this.gpuMonitor.getEnrichedInventory();
    const gpuConfig = this.gpuMonitor.getConfig();
    const clusterGpus = getClusterGpus(inventory, gpuConfig, {});
    const assignments = loadGpuAssignments();
    const assignedPcis = new Set(assignments[String(vmid)]?.gpus || []);

    const archs = new Set();
    for (const gpu of clusterGpus) {
      if (gpu.node === node && assignedPcis.has(gpu.pciId) && gpu.spec?.arch) {
        archs.add(gpu.spec.arch);
      }
    }
    return [...archs];
  }

  /**
   * Get the primary GPU vendor assigned to an agent container.
   * @param {string} node - PVE node name
   * @param {number} vmid - Agent container VMID
   * @returns {string} 'NVIDIA', 'AMD', 'Intel', or 'unknown'
   */
  getAgentGpuVendor(node, vmid) {
    const inventory = this.gpuMonitor.getEnrichedInventory();
    const gpuConfig = this.gpuMonitor.getConfig();
    const clusterGpus = getClusterGpus(inventory, gpuConfig, {});
    const assignments = loadGpuAssignments();
    const assignedPcis = new Set(assignments[String(vmid)]?.gpus || []);

    for (const gpu of clusterGpus) {
      if (gpu.node === node && assignedPcis.has(gpu.pciId) && gpu.provider === 'nvidia') return 'NVIDIA';
    }
    return 'unknown';
  }

  /**
   * Get the PVE host IP for a node.
   * @param {string} node - PVE node name
   * @returns {string|null} Host IP or null
   */
  getNodeHostIp(node) {
    const nodeMap = this.pveApi.getNodeMap();
    return nodeMap[node]?.ip || null;
  }

  /**
   * Get the VMID for a node's agent container.
   * @param {string} node - PVE node name
   * @param {Object} aiConfig - AI config
   * @returns {number|null} VMID or null
   */
  getAgentVmid(node, aiConfig) {
    return aiConfig?.agents?.[node]?.vmid || null;
  }

  /**
   * Read a provider's install script content from disk.
   * @param {string} providerId - Provider ID
   * @returns {string} Script content
   */
  readInstallScript(providerId) {
    const provider = getProvider(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    const scriptPath = join(scriptsDir, provider.scriptFile);
    return readFileSync(scriptPath, 'utf-8');
  }

  /**
   * Get all scripts needed for a provider's install chain.
   * Returns an array of { name, path, content } for each script in the chain,
   * plus the orchestrator itself.
   *
   * @param {string} providerId - Provider ID
   * @param {string} vendor - GPU vendor (NVIDIA, Intel, AMD)
   * @returns {Array<{ name: string, remotePath: string, content: string }>}
   */
  getInstallScripts(providerId, vendor = 'NVIDIA') {
    const provider = getProvider(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);

    const vendorLower = vendor.toLowerCase();
    const scripts = [];

    // Always include the orchestrator
    const orchestratorPath = join(setupDir, 'orchestrator.sh');
    scripts.push({
      name: 'orchestrator',
      remotePath: '/tmp/proxlab-install/orchestrator.sh',
      content: readFileSync(orchestratorPath, 'utf-8'),
    });

    // Always include shared-symlinks helper (sourced by provider scripts)
    const sharedSymlinksPath = join(scriptsDir, 'prereqs', 'shared-symlinks.sh');
    if (existsSync(sharedSymlinksPath)) {
      scripts.push({
        name: 'shared-symlinks',
        remotePath: '/tmp/proxlab-install/providers/prereqs/shared-symlinks.sh',
        content: readFileSync(sharedSymlinksPath, 'utf-8'),
      });
    }

    // Resolve each step in the install chain to a script file
    const chain = provider.installChain || [];
    for (const step of chain) {
      // Replace {vendor} placeholder with actual vendor
      const resolvedStep = step.replace(/\{vendor\}/g, vendorLower);

      let localPath;
      let remotePath;
      if (resolvedStep.startsWith('providers/')) {
        // Provider scripts live in scripts/providers/
        const subPath = resolvedStep.replace('providers/', '');
        localPath = join(scriptsDir, subPath + '.sh');
        remotePath = `/tmp/proxlab-install/${resolvedStep}.sh`;
      } else if (resolvedStep === 'base-packages') {
        // Special case: base-packages maps to install-base-packages.sh
        localPath = join(setupDir, 'install-base-packages.sh');
        remotePath = '/tmp/proxlab-install/install-base-packages.sh';
      } else if (resolvedStep === 'install-conda') {
        localPath = join(setupDir, 'install-conda.sh');
        remotePath = '/tmp/proxlab-install/install-conda.sh';
      } else if (resolvedStep.startsWith('drivers/') || resolvedStep.startsWith('gpu-libs/')) {
        // Sub-directory scripts
        localPath = join(setupDir, resolvedStep + '.sh');
        remotePath = `/tmp/proxlab-install/${resolvedStep}.sh`;
      } else {
        // Default: setup directory
        localPath = join(setupDir, resolvedStep + '.sh');
        remotePath = `/tmp/proxlab-install/${resolvedStep}.sh`;
      }

      if (existsSync(localPath)) {
        scripts.push({
          name: resolvedStep,
          remotePath,
          content: readFileSync(localPath, 'utf-8'),
        });
      } else {
        // Script doesn't exist yet (future provider) — orchestrator will skip
        console.warn(`Install script not found: ${localPath} — will be skipped`);
      }
    }

    return scripts;
  }

  /**
   * Parse PROXLAB_STATUS and PROXLAB_VERSION from script output.
   * @param {string} output - Combined stdout from the script
   * @returns {{ status: string, version: string }}
   */
  parseOutput(output) {
    const statusMatch = output.match(/^PROXLAB_STATUS=(.+)$/m);
    const versionMatch = output.match(/^PROXLAB_VERSION=(.+)$/m);
    const updateMatch = output.match(/^PROXLAB_UPDATE_AVAILABLE=(.+)$/m);
    return {
      status: statusMatch?.[1]?.trim() || 'unknown',
      version: versionMatch?.[1]?.trim().startsWith('$(') ? '' : (versionMatch?.[1]?.trim() || ''),
      updateAvailable: updateMatch?.[1]?.trim() || '',
    };
  }

  /**
   * Execute a provider action on a single agent container.
   * @param {string} providerId - Provider ID
   * @param {string} containerIp - Container IP address
   * @param {string} action - 'install' | 'uninstall' | 'status'
   * @param {Object} opts - { archs, vendor, installDir }
   * @returns {Promise<{ ok: boolean, status: string, version: string, error?: string, output?: string }>}
   */
  async execOnContainer(providerId, containerIp, action, opts = {}) {
    const provider = getProvider(providerId);
    if (!provider) return { ok: false, error: `Unknown provider: ${providerId}` };

    const archs = opts.archs || '';
    const vendor = opts.vendor || 'NVIDIA';
    const installDir = opts.installDir || `/opt/${providerId}`;
    const timeout = action === 'install' || action === 'update' ? 600000 : 30000;

    try {
      // Read and upload the script
      const scriptContent = this.readInstallScript(providerId);
      const remotePath = `/tmp/proxlab-install-${providerId}.sh`;

      const uploadCmd = `cat > '${remotePath}' << 'PROXLAB_SCRIPT_EOF'\n${scriptContent}\nPROXLAB_SCRIPT_EOF\nchmod +x '${remotePath}'`;
      const uploadResult = await this.sshService.exec(containerIp, uploadCmd, { timeout: 30000 });
      if (uploadResult.code !== 0) {
        return { ok: false, error: `Script upload failed: ${uploadResult.stderr}` };
      }

      // Execute the script with environment variables
      const envVars = [
        `PROXLAB_GPU_ARCHS="${archs}"`,
        `PROXLAB_GPU_VENDOR="${vendor}"`,
        `PROXLAB_INSTALL_DIR="${installDir}"`,
      ].join(' ');
      const execCmd = `${envVars} '${remotePath}' ${action} 2>&1`;

      const result = await this.sshService.exec(containerIp, execCmd, { timeout });
      const parsed = this.parseOutput(result.stdout);

      // Cleanup (best-effort)
      this.sshService.exec(containerIp, `rm -f '${remotePath}'`, { timeout: 5000 }).catch(() => {});

      if (result.code !== 0 && parsed.status !== 'installed' && parsed.status !== 'not_installed') {
        return {
          ok: false,
          status: parsed.status,
          version: parsed.version,
          error: `Script exited with code ${result.code}`,
          output: result.stdout.slice(-500),
        };
      }

      return {
        ok: true,
        status: parsed.status,
        version: parsed.version,
        updateAvailable: parsed.updateAvailable || '',
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Install a provider on specified agents (or all agents).
   * @param {string} providerId - Provider ID
   * @param {Object} aiConfig - Current ai-config.json content
   * @param {Object} opts - { nodes?: string[] } - specific nodes, or all agents
   * @returns {Promise<Object>} Per-node results
   */
  async installProvider(providerId, aiConfig, opts = {}) {
    const agents = aiConfig.agents || {};
    const targetNodes = opts.nodes || Object.keys(agents);
    const results = {};

    for (const node of targetNodes) {
      const agent = agents[node];
      if (!agent?.vmid) {
        results[node] = { ok: false, error: 'No agent designated' };
        continue;
      }

      const ip = this.getContainerIp(agent.vmid);
      if (!ip) {
        results[node] = { ok: false, error: `Cannot resolve IP for CT ${agent.vmid}` };
        continue;
      }

      const archs = this.getAgentGpuArchs(node, agent.vmid).join(',');
      const vendor = this.getAgentGpuVendor(node, agent.vmid);

      results[node] = await this.execOnContainer(providerId, ip, 'install', {
        archs, vendor,
      });
    }

    return results;
  }

  /**
   * Uninstall a provider from specified agents (or all agents).
   */
  async uninstallProvider(providerId, aiConfig, opts = {}) {
    const agents = aiConfig.agents || {};
    const targetNodes = opts.nodes || Object.keys(agents);
    const results = {};

    for (const node of targetNodes) {
      const agent = agents[node];
      if (!agent?.vmid) {
        results[node] = { ok: false, error: 'No agent designated' };
        continue;
      }

      const ip = this.getContainerIp(agent.vmid);
      if (!ip) {
        results[node] = { ok: false, error: `Cannot resolve IP for CT ${agent.vmid}` };
        continue;
      }

      results[node] = await this.execOnContainer(providerId, ip, 'uninstall');
    }

    return results;
  }

  /**
   * Check provider status on specified agents (or all agents).
   */
  async checkStatus(providerId, aiConfig, opts = {}) {
    const agents = aiConfig.agents || {};
    const targetNodes = opts.nodes || Object.keys(agents);
    const results = {};

    for (const node of targetNodes) {
      const agent = agents[node];
      if (!agent?.vmid) {
        results[node] = { ok: false, error: 'No agent designated' };
        continue;
      }

      const ip = this.getContainerIp(agent.vmid);
      if (!ip) {
        results[node] = { ok: false, error: `Cannot resolve IP for CT ${agent.vmid}` };
        continue;
      }

      results[node] = await this.execOnContainer(providerId, ip, 'status');
    }

    return results;
  }

  /**
   * Check for available updates on specified agents.
   * Scripts that support 'check-update' will emit PROXLAB_UPDATE_AVAILABLE=x.y.z
   */
  async checkUpdate(providerId, aiConfig, opts = {}) {
    const agents = aiConfig.agents || {};
    const targetNodes = opts.nodes || Object.keys(agents);
    const results = {};

    for (const node of targetNodes) {
      const agent = agents[node];
      if (!agent?.vmid) continue;
      const ip = this.getContainerIp(agent.vmid);
      if (!ip) continue;

      const result = await this.execOnContainer(providerId, ip, 'check-update');
      results[node] = result;
    }

    return results;
  }

  /**
   * Update provider on specified agents.
   */
  async updateProvider(providerId, aiConfig, opts = {}) {
    const agents = aiConfig.agents || {};
    const targetNodes = opts.nodes || Object.keys(agents);
    const results = {};

    for (const node of targetNodes) {
      const agent = agents[node];
      if (!agent?.vmid) {
        results[node] = { ok: false, error: 'No agent designated' };
        continue;
      }

      const ip = this.getContainerIp(agent.vmid);
      if (!ip) {
        results[node] = { ok: false, error: `Cannot resolve IP for CT ${agent.vmid}` };
        continue;
      }

      results[node] = await this.execOnContainer(providerId, ip, 'update');
    }

    return results;
  }
}
