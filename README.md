# dsh-nx

A DeepSeek Harness plugin for driving **Siemens NX** through
[nx-auto-mcp](https://github.com/cyw2527/nx-auto-mcp) — by making the startup
chain observable and repairable instead of guessable.

`nx-auto-mcp` already exposes 123 NX tools over MCP, and when the chain is up they
work. The problem is the chain: **five things must be true at once**, and when one
is false the model sees only `No work part is open.` or an empty PNG.

| # | Link | When it is false you see |
|---|------|--------------------------|
| 1 | `ugraf.exe` is running | every `nx_*` tool fails to connect |
| 2 | `managed_plugin.dll` is deployed | no menu, no listener, **no error** |
| 3 | that DLL is loadable | same silence — NX refuses unsigned plugins without a message |
| 4 | the plugin's TCP server is listening | connection refused |
| 5 | the NX window is renderable | screenshots succeed and contain nothing |

This plugin gives the agent one tool, `nx`, that inspects all five links
separately, and repairs the ones that can be repaired from outside NX.

It does **not** replace the MCP server: keep `@deepseek-ai/dsh-mcp-client` wired
to `mcp/nx-auto-mcp.js` for the 123 modelling tools. This is the layer underneath
them.

## What it does

| action | purpose |
|--------|---------|
| `status` | The five links, the deployed DLL, its signature state, the newest NX syslog, and the window — each row *observed* or explicitly *unknown*. |
| `call` | Run one plugin tool straight over TCP, bypassing the MCP client. |
| `tools` | The live inventory, for the same reason. |
| `launch` | Start `ugraf.exe` with `UGII_CUSTOM_DIRECTORY_FILE` / `UGII_USER_DIR` set, then **poll the port** instead of sleeping. |
| `focus` | Restore and foreground the NX window. |
| `capture` | Focus → settle → fit → screenshot → **verify the file**. |
| `deploy` | Compile, sign and install the managed plugin, reporting each step separately. |

### Why `call` exists

An MCP client pulls `tools/list` **once, at connect time**. Deploy a new tool into
NX and it is invisible until the client reconnects. `call` talks to the plugin
directly, so it always sees the live inventory — and it reports what the plugin
said, not what a cached list believed.

### Why `capture` waits

NX exports the graphics buffer, not a fresh render. Capture a window that is still
repainting — just restored, just uncovered — and NX writes a file of the right
size containing uninitialised pixels, and reports success. The action therefore
focuses, waits, fits the view, waits again, and measures the resulting file before
calling it a capture. A minimized window is the other half of the same failure: it
has no renderable surface at all.

### Why the window is matched by process id

The NX title is `NX` at the gateway, `part - NX - Gateway` with a part open, and
localised on other installs. A loose match on `NX` also hits unrelated windows (an
Explorer folder named `SiemensNX-2412`, for instance). So the window is selected by
owning process — the title fragment only breaks ties.

## Install

```powershell
dsh plugin --profile web add D:/deepseek_harness/dsh-nx
```

Or link it by hand, the way the other `@dsh-external` plugins in this profile are
linked:

```powershell
# 1. junction into the profile
New-Item -ItemType Junction `
  -Path  "$env:USERPROFILE\.dsh\profiles\web\node_modules\@dsh-external\dsh-nx" `
  -Target "D:\deepseek_harness\dsh-nx"

# 2. add to the profile's bundles (package.json → dsh.profile.bundles)
# 3. restart the app
```

Config lives on the row that `cordis.patch.yml` inserts:

```yaml
- insert:
    - id: tool-nx
      name: '@dsh-external/dsh-nx'
      config:
        nxRoot: 'D:\Program Files\Siemens\NX2412'
        nxAutoMcpPath: 'D:\deepseek_harness\ug\_repo'
```

Every field is optional. `nxRoot` falls back to `UGII_BASE_DIR`, then to an
`NX*` scan of `Program Files`; `nxAutoMcpPath` has no fallback, because the only
honest answer when the package is unknown is "unknown".

| field | default | meaning |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `1977` | plugin TCP endpoint |
| `nxRoot` | detected | NX install root |
| `nxAutoMcpPath` | — | nx-auto-mcp checkout (needed by `deploy`) |
| `customDirsFile` | `<nxAutoMcpPath>/custom_dirs.dat` | what `launch` exports |
| `userDir` | `<nxAutoMcpPath>` | what `launch` exports as `UGII_USER_DIR` |
| `exePath` | `<nxRoot>/NXBIN/ugraf.exe` | what `launch` starts |
| `windowTitle` | `NX - Gateway` | preferred title fragment for `focus`/`capture` |
| `callTimeoutMs` | `180000` | per TCP call |
| `launchTimeoutMs` | `240000` | how long `launch` waits for the port |
| `deployExecTimeoutMs` | `300000` | csc / SignDotNet wall clock |

## Usage

Ask for state first; it is the difference between "the plugin is not loaded" and
"the plugin said no":

```
nx status
```

Run a tool the MCP client has not noticed yet:

```
nx call  tool=nx_measure_volume  params={}
```

Start NX correctly when it is not running:

```
nx launch
```

Screenshot something that actually contains the model:

```
nx capture  imagePath=D:/tmp/nx.png
```

Rebuild after changing the plugin source:

```
nx deploy
```

## What `deploy` will and will not claim

`deploy` reports compile, sign and install **separately**, because they fail for
different reasons and only one of them is about your code.

Two facts worth knowing, both learned the hard way on NX 2412:

- **Signing can fail while NX still loads the DLL.** `SignDotNet` asks the licence
  server for the *author* licence; NX at runtime asks for a different grant. A
  machine can have the second without the first — the syslog then says
  `DotNet author license is present. Authentication passed` for an unsigned DLL.
  So a signing failure is reported as a failure, deployment continues, and the
  outcome is stated rather than smoothed over.
- **`NXSigningResource.res` lives in `UGOPEN`**, which a runtime-only NX install
  does not have. Without it the DLL is compiled without the resource bundle and
  cannot be signed at all — not a code problem, and not fixable from this plugin.

## Verification

```powershell
npm test                          # 13 tests: wire format, config, selection rules, tool schema
$env:NX_AUTO_MCP_PATH = 'D:\deepseek_harness\ug\_repo'
node scripts/live-check.mjs       # against a real NX; launches it if needed
```

The unit tests run the TCP layer against a fake plugin: the wire format is the
contract that matters, and it can be pinned without a licence, a desktop session,
or a running CAD system. `scripts/live-check.mjs` is the other half and starts NX.

Observed on NX 2412 / Windows 11 (2026-10-26): `launch` → port open in 8–12 s,
`status` → 123 tools, `call` → working modelling calls, `capture` → a 17 KB render
of the model.

## Limitations

- **Windows only.** NX is, and so are the window and process probes.
- **`focus`/`capture` need a desktop session.** A process in another session cannot
  see or restore NX's window; the actions say so instead of failing silently.
- **`deploy` cannot sign what the licence server will not grant.** See above.
- **`status` reads the newest `*.syslog` in `%TEMP%`**, which may predate the
  current NX session. The row carries the log's timestamp so a stale reading is
  visible rather than mistaken for the present.

## License

MIT. Not affiliated with Siemens or with nx-auto-mcp.
