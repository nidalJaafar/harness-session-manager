import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export class HarnessRegistry {
  constructor() { this.plugins = new Map(); }
  register(plugin) { validatePlugin(plugin); if (this.plugins.has(plugin.id)) throw new Error(`Harness already registered: ${plugin.id}`); this.plugins.set(plugin.id, plugin); return this; }
  async loadExternal(files = discoverPluginFiles()) { for (const file of files) { const module = await import(pathToFileURL(file)); this.register(module.default || module.harnessPlugin); } return this; }
  create(context = {}, only = '') { return [...this.plugins.values()].filter((plugin) => !only || plugin.id === only).map((plugin) => { const adapter = plugin.create(context); validateAdapter(adapter, plugin.id); return adapter; }); }
}

export function discoverPluginFiles(configDir = process.env.HSM_CONFIG_DIR || path.join(os.homedir(), '.config/hsm')) {
  const directory = path.join(configDir, 'plugins');
  const local = fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.mjs') || name.endsWith('.js')).map((name) => path.join(directory, name)) : [];
  const configured = String(process.env.HSM_PLUGINS || '').split(path.delimiter).filter(Boolean).map((file) => path.resolve(file));
  return [...new Set([...local, ...configured])];
}

function validatePlugin(plugin) { if (!plugin?.id || !plugin?.name || typeof plugin.create !== 'function') throw new Error('Harness plugin must provide id, name, and create(context).'); }
function validateAdapter(adapter, id) { for (const method of ['available', 'sessions', 'preview']) if (typeof adapter?.[method] !== 'function') throw new Error(`Harness ${id} adapter is missing ${method}().`); if (adapter.id !== id) throw new Error(`Harness plugin ${id} created adapter ${adapter.id || 'without id'}.`); }
