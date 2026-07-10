import {ClaudeAdapter, OpenCodeAdapter} from '../adapters.mjs';
import {PiAdapter} from './pi.mjs';
import {HarnessRegistry} from './registry.mjs';

export const builtinHarnesses = [
  {id: 'claude', name: 'Claude Code', create: (context) => new ClaudeAdapter({limit: context.limit})},
  {id: 'opencode', name: 'OpenCode', create: (context) => new OpenCodeAdapter({dbPath: context.dbPath})},
  {id: 'pi', name: 'Pi', create: (context) => new PiAdapter({agentDir: context.piAgentDir, sessionDir: context.piSessionDir})},
];

export async function createHarnessAdapters({only = '', ...context} = {}) {
  const registry = new HarnessRegistry();
  for (const plugin of builtinHarnesses) registry.register(plugin);
  await registry.loadExternal();
  return registry.create(context, only);
}
