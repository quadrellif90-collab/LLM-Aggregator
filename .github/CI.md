# CI

La build parte automaticamente sui push a `main` e sui tag `v*`, oppure manualmente da Actions → Build & Release.

Produce nella GitHub Release:
- `llm-aggregator-win.zip` — gateway standalone (.exe con Node integrato)
- (best-effort) installer Tauri `.exe`/`.msi`
