# Feishu Sync

This directory is the independent Obsidian desktop plugin source of truth.
Build, tests, packaging, and documentation must work without a particular vault,
Components, Dataview, or Tasks. Optional vault dashboards call the plugin's
`service`, `openPanel`, `syncNow`, and `getAutoStatus` interfaces.

Preserve the `feishu-sync` plugin ID, existing settings, identity markers and
Feishu GUIDs. Project synchronization is the default; extra folders and tags
are opt-in. Keep note selection in `lib/feishu-scope.cjs` shared by the service,
scheduler and interface. Ordinary task notes do not acquire project metadata.

Use `npm test` for synchronization or lifecycle changes, `npm run check-release`
after building, and `npm run package` for release assets. Keep all version files
consistent. Include a regression test when changing task discovery or writes.

Keep user instructions short and actionable. Explain actual errors at the point
of failure. Store local test evidence in ignored `evidence/`; never include real
credentials, vault notes, or association records in source or release artifacts.
