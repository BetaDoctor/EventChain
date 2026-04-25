@echo off

REM ─── Deno upgrade check ────────────────────────────────────────────────────
REM Phones home to dl.deno.land on every startup to check for a newer Deno.
REM --dry-run only prints whether an upgrade is available; it does NOT install.
REM Installing is a manual decision (run `bin\deno.exe upgrade` yourself).
"%~dp0bin\deno.exe" upgrade --dry-run

REM ─── Config ────────────────────────────────────────────────────────────────
REM All deployment config (wallets, webhooks, contract hash, network, etc.)
REM lives in `.env` at the project root. That file is gitignored — never
REM commit it. Template: `.env.example`. If `.env` is missing the server
REM fails to start with a clear error naming the missing variable.

if not exist "%~dp0.env" (
  echo.
  echo   ERROR: .env not found at %~dp0.env
  echo   Copy .env.example to .env and fill it in before running.
  echo.
  exit /b 1
)

"%~dp0bin\tailwindcss.exe" -c "%~dp0bin\tailwind.config.js" -i "%~dp0bin\tailwind.input.css" -o "%~dp0bin\public\tailwind.css" --minify

REM Pin Deno's module cache INSIDE bin/ so --allow-read=bin covers it too
REM (Lucid's WASM is loaded via require() from this cache at runtime).
set "DENO_DIR=%~dp0bin\deno-cache"

REM Narrow permissions:
REM   --env-file  : load .env from project root (processed before sandbox)
REM   --allow-net : only Koios (mainnet API) + loopback (for our own :8000)
REM   --allow-read: everything under bin/ (source, WASM, markets.json, cache)
REM   --allow-write: only markets.json writes + Deno's own cache-maintenance
REM   --allow-env : just the vars we read (all EVENTCHAIN_* + DISCORD_*)
REM   --lock+--frozen : refuse to start if lockfile integrity fails; no silent
REM                     dep updates (supply-chain hardening).
"%~dp0bin\deno.exe" run ^
  --env-file="%~dp0.env" ^
  --lock="%~dp0bin\deno.lock" --frozen ^
  --allow-net=api.koios.rest,127.0.0.1,localhost,discord.com,discordapp.com ^
  --allow-read="%~dp0bin" ^
  --allow-write="%~dp0bin\data","%~dp0bin\deno-cache" ^
  --allow-env=EVENTCHAIN_PROD,EVENTCHAIN_HOST,EVENTCHAIN_PORT,EVENTCHAIN_TRUST_XFF,EVENTCHAIN_NETWORK,EVENTCHAIN_KOIOS_URL,EVENTCHAIN_PUBLIC_URL,EVENTCHAIN_SCRIPT_HASH,EVENTCHAIN_ECT_UNIT,EVENTCHAIN_ORACLE_ADDRESS,EVENTCHAIN_ORACLE_VKH,EVENTCHAIN_TREASURY_ADDRESS,DENO_DIR,DISCORD_ANNOUNCE_WEBHOOK,DISCORD_MODLOG_WEBHOOK,DISCORD_ADMIN_WEBHOOK,DISCORD_AUDIT_WEBHOOK ^
  --config "%~dp0bin\deno.json" ^
  "%~dp0bin\src\server\mod.ts"
