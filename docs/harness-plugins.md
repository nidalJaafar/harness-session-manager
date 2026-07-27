# Harness plugins

HSM treats every coding harness as a plugin. The model, dashboard, browser, search, palette, persistence, status engine, and TUI only consume normalized adapters.

## External plugin

Create `~/.config/hsm/plugins/my-harness.mjs`:

```js
export default {
  id: 'my-harness',
  name: 'My Harness',
  create(context) {
    return {
      id: 'my-harness',
      name: 'My Harness',
      newSession: {command: 'my-harness', args: []},
      available() {
        return true;
      },
      async sessions() {
        return [];
      },
      async preview(session) {
        return [];
      },
    };
  },
};
```

Restart HSM. Files ending in `.js` or `.mjs` are discovered automatically. Additional plugin files can be supplied through the platform-delimited `HSM_PLUGINS` environment variable.

## Normalized session

`sessions()` returns objects with these core fields:

```js
{
  id: 'native-id',
  harness: 'my-harness',
  harnessName: 'My Harness',
  title: 'Session title',
  project: 'repo-name',
  cwd: '/absolute/repo/path',
  updatedAt: Date.now(),
  createdAt: Date.now(),
  isSubagent: false,
  resume: {command: 'my-harness', args: ['--resume', 'native-id']},
  capabilities: {
    rename: false, tag: false, archive: false, delete: false,
    move: false, preview: true, cost: false, git: false, liveEvents: false,
  },
}
```

Optional normalized fields include `branch`, `tag`, `parentId`, `model`, `agent`, `cost`, `tokens`, `git`, and `raw`. Capability methods such as `rename(session, title)`, `tag`, `archive`, `restore`, and `move` are exposed only when supported.

`newSession` is an optional adapter-level declaration. When present, HSM automatically includes the harness in the `n` launcher and command palette. `command` is the native executable and `args` contains any arguments required to begin a fresh interactive session; HSM supplies the user-selected working directory.

An adapter may also expose `processes()` to return normalized `{harness, sessionId, pid, cwd}` records when its process model cannot be covered by HSM's built-in detector. A harness-specific extension or hook can report live state through `hsm event --harness <id> --session <id> --type running|waiting|completed|failed`.

HSM 1.0 recognizes these optional adapter methods without requiring them from older plugins:

- `messagesSince(session, cursor)` returns normalized messages for incremental local indexing; HSM falls back to `preview()`.
- `projectIdentity(session)` returns a stable repository or project key.
- `prepareLaunch({cwd})` returns a native launch declaration.
- `processes()` and existing capability methods continue to enrich live state and management actions.

Indexed messages may add `createdAt` and referenced paths. Transcript content remains in the local HSM database.

`preview()` returns chronological `{role: 'user' | 'assistant', text: '...'}` messages.

Built-in integrations are declared in `src/harnesses/index.mjs`. Adding another built-in requires an adapter module and one descriptor in `builtinHarnesses`; no model or UI edits are required. Unknown harnesses receive a neutral badge until a custom badge style is added.
