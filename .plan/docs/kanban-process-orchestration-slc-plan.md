# Kanban Process Orchestration SLC Plan

## Finish Contract

Kanban is complete for this sprint when the current app proves these paths without relying on Maenifold Gate as a second tool:

1. Define an arbitrary process in Kanban with stage prompts, roles, agent IDs, pass/fail transitions, terminal states, and conditional transitions.
2. Assign any built-in or custom process to a Kanban item from the task create/edit UI and CLI.
3. Run a ready process item from the UI or CLI so Kanban advances passive dispatch stages, starts the effective runnable stage with a fresh agent prompt, and records dispatch history.
4. Give each fresh agent exact guarded Kanban CLI commands for append/pass/fail with `--process`, `--expected-stage`, and `--agent`.
5. Record pass/fail through Kanban UI and CLI so the item advances along the process graph, including fail edges that move it back to the configured stage.
6. Show proof in the UI that the item has or has not gone through every required stage: route, counts, pass/fail history, current stage, effective ready stage, and completion state.
7. Prevent incomplete process items from being moved to Done except through a terminal process pass.
8. Keep Gate semantics where they matter: exact current-stage filtering for status, guarded mutations, and pass/fail-only outcomes.

## Current Evidence To Maintain

- `src/core/task-process.ts` owns process definitions, validation, prompt generation, passive dispatch, running state, transitions, history, and reopen.
- `src/commands/task.ts` owns CLI import/export/remove/status/run-ready/history/body/append/pass/fail/reopen.
- `web-ui/src/components/process-definitions-dialog.tsx` owns process editing and JSON import/export.
- `web-ui/src/components/process-status-queue.tsx` owns queue visibility, effective ready stage display, filters, and bulk run.
- `web-ui/src/components/task-process-panel.tsx` owns per-card audit route, command preview, append/pass/fail/reopen controls, and history.
- `web-ui/src/state/board-state.ts` owns movement guards for incomplete process items.

## Verification Gates

- Unit tests for process graph behavior and launch prompts.
- Web UI tests for process editor, queue, task panel, and Done guard.
- CLI integration tests for custom import, create assignment, status filters, run-ready, pass/fail, terminal pass, and dependent release.
- Browser UAT on `http://127.0.0.1:4173/kanban` showing process assignment, process queue effective stage, route/history audit, and pass/fail movement.
