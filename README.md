# LLM Aggregator

Un gateway locale **OpenAI-compatible** che unifica decine di provider LLM dietro un'unica API, con autorouting, failover, cache e una control panel. È la rivisitazione modulare e libera da dipendenze di `modelhub-ai-gateway`.

## Funzionalità
- Endpoint OpenAI compatibile su `http://127.0.0.1:9090/v1` (`chat/completions`, `embeddings`, `models`).
- **Autorouting**: sceglie il modello giusto in base al profilo e al contenuto del prompt (code / reasoning / fast / free-pool).
- **Failover** su più provider con timeout configurabili.
- **Cache** delle risposte (SHA-256 key) per risparmiare token e latenza.
- **Metriche** Prometheus su `/metrics` e health check su `/v1/health`.
- **Control API** protetta da token su `/hub/*` (`state`, `config`, `models`, `profile`, `key`, `features`, `pricing`, `export`).
- **Zero dipendenze npm**: usa solo i moduli nativi di Node (`node:http`, `node:https`, `node:crypto`…). Gira anche su Bun.
- **Shell Tauri** (Rust) opzionale che avvia il gateway e apre la control panel in una webview nativa.

## Avvio
```bash
npm run server          # avvia il gateway su :9090
# oppure con Bun
bun server/index.js
```
Apri `http://127.0.0.1:9090/` nella control panel.

## Shell desktop (Tauri)
```bash
npm install
npm run tauri dev       # sviluppo
npm run tauri build     # build nativa (richiede la toolchain Rust)
```

## Configurazione
- `config.json` — provider e modelli.
- `pricing.json` — tariffa per 1M token (per provider o per modello).
- `prefs.json` — profili, strategie, enhancer, feature.
- `auth.json` — chiavi API, crittografate con **AES-256-GCM** legate alla macchina.

## Variabili d'ambiente
- `AGG_PORT` / `MODELHUB_PORT` — porta (default `9090`).
- `AGG_TOKEN` / `MODELHUB_TOKEN` — token per la `/hub` API.
- `AGG_DIR` / `MODELHUB_DIR` — cartella dei dati.
- `AGG_CACHE` — `0` per disabilitare la cache.
- `AGG_AUTH_KEY` — chiave di cifratura esplicita (altrimenti derivata da host+utente).

## Licenza
MIT
