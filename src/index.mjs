#!/usr/bin/env node
import {DEFAULT_OPENCODE_DB} from './adapters.mjs';
import {createHarnessAdapters} from './harnesses/index.mjs';
import {SessionHubModel} from './model.mjs';
import {ensureBun} from './runtime.mjs';
import {render, run} from './tui.mjs';
import {ensureHooksInstalled, runSubcommand} from './cli.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: hsm [--preview] [--db path] [--only claude|opencode|pi] [--show-subagents]\n       hsm event --harness <id> --session <id> --type <type>\n       hsm hooks install|remove|status\n       hsm doctor\n\nUnified coding-harness command center.');
  process.exit(0);
}
if (await runSubcommand(args)) process.exit(0);
const only = value('--only', '');
const adapters = await createHarnessAdapters({only, dbPath: value('--db', DEFAULT_OPENCODE_DB)});
const model = new SessionHubModel({adapters, showSubagents: args.includes('--show-subagents') ? true : undefined});
try {
  if (args.includes('--preview')) { await model.load(); model.width = Number(value('--width', 120)); model.height = Number(value('--height', 36)); console.log(render(model)); }
  else {
    try { ensureHooksInstalled(); } catch (error) { console.error(`hsm: automatic hook setup failed: ${error.message}`); }
    ensureBun();
    await run(model);
  }
} catch (error) { console.error(`hsm: ${error.message}`); process.exit(1); }
