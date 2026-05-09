# Stub CLI Contract — `stub-gh` / `stub-glab`

## Purpose

`stub-gh` and `stub-glab` are bash shims that replace the real `gh` and `glab`
CLI tools during issue-artifacts tests. Tests prepend the fixture directory to
`$PATH` so every `gh` or `glab` invocation hits the stub instead of the real
binary. The stubs are scenario-driven: behavior is defined entirely by JSON
scenario files, not by hardcoded argv parsing in the shim itself.

## Ledger isolation

Each test MUST set a per-test ledger path via environment variable:

| Shim       | Env var              |
|------------|----------------------|
| `stub-gh`  | `STUB_GH_LEDGER`    |
| `stub-glab`| `STUB_GLAB_LEDGER`  |

**Rules:**

1. When the env var is set, the shim appends one JSONL entry per invocation to
   that path.
2. When the env var is **unset**, the shim refuses to run. It prints to stderr:
   ```
   [stub-gh] STUB_GH_LEDGER unset; refusing to write to a default path. Set STUB_GH_LEDGER=$tmpDir/recorded-calls.jsonl from your test.
   ```
   (substitute `stub-glab` / `STUB_GLAB_LEDGER` for the glab variant) and exits
   with code **2**.
3. The shim **NEVER** defaults to a path inside `test/fixtures/issue-artifacts/`.
   Ledger files are always test-owned temp paths.

### TypeScript usage

```typescript
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmpDir = mkdtempSync(join(tmpdir(), "my-test-"));
const ledger = join(tmpDir, "recorded-calls.jsonl");

const result = Bun.spawnSync({
  cmd: ["gh", "issue", "view", "42", "--json", "number,title"],
  env: {
    ...process.env,
    STUB_GH_LEDGER: ledger,
    STUB_GH_SCENARIO: "/path/to/scenario.json",
  },
});
```

The env var names must be used verbatim — `STUB_GH_LEDGER` for `stub-gh`,
`STUB_GLAB_LEDGER` for `stub-glab`. Scenario files are set via
`STUB_GH_SCENARIO` / `STUB_GLAB_SCENARIO` respectively.

## Scenario files

Behavior is driven by a JSON file whose path is set in `STUB_GH_SCENARIO`
(or `STUB_GLAB_SCENARIO`). If the env var is unset or the file doesn't exist,
the shim exits 1 with stderr `[stub-gh] no scenario file`.

### Scenario file format

```json
[
  {
    "match": {
      "argv_contains": ["issue", "create"]
    },
    "response": {
      "stdout": "{\"url\":\"https://github.com/test/repo/issues/42\",\"number\":42}",
      "stderr": "",
      "exitCode": 0
    }
  }
]
```

- `match.argv_contains` — array of strings. The shim checks whether **every**
  string in this array appears somewhere in the actual argv. First matching
  entry wins.
- `response.stdout` — printed to stdout.
- `response.stderr` — printed to stderr.
- `response.exitCode` — the process exit code.

If no entry matches, the shim exits 1 with stderr:
```
[stub-gh] no scenario match for: <actual args joined by space>
```

## Recorded log format (JSONL)

One JSON object per line, appended to the ledger file on every invocation:

```json
{
  "ts": "2026-05-09T12:00:00.000Z",
  "bin": "gh",
  "argv": ["issue", "create", "--title", "foo"],
  "stdin_sha256": null,
  "scenario": "/tmp/test-xyz/scenarios/foundation-smoke.json",
  "scenario_match_index": 0,
  "response_code": 0
}
```

| Field                  | Type              | Description                                      |
|------------------------|-------------------|--------------------------------------------------|
| `ts`                   | `string`          | ISO 8601 timestamp of invocation                 |
| `bin`                  | `string`          | `"gh"` or `"glab"`                               |
| `argv`                 | `string[]`        | Full argument vector (excluding the binary name)  |
| `stdin_sha256`         | `string \| null`  | SHA-256 of stdin if piped, otherwise `null`       |
| `scenario`             | `string`          | Absolute path to the scenario file used           |
| `scenario_match_index` | `number`          | Index of the matched entry in the scenario array  |
| `response_code`        | `number`          | Exit code returned to the caller                  |

## Supported subcommands

The stubs don't hardcode subcommand logic — all behavior comes from scenario
files. However, the following subcommands are expected to appear in scenario
files across the test suite:

### Issue-artifacts layer

| Subcommand         | Typical argv pattern                          |
|--------------------|-----------------------------------------------|
| `create`           | `issue create --title ... --body ...`         |
| `update`           | `issue edit <number> --body ...`              |
| `read`             | `issue view <number> --json ...`              |
| `comment`          | `issue comment <number> --body ...`           |
| `close`            | `issue close <number>`                        |
| `find`             | `issue list --label <label> --json ...`       |
| `list-by-label`    | `issue list --label <label> --json ...`       |
| `validate-url`     | `issue view <number> --json url`              |
| `handoff`          | `issue comment <number> --body ...` (handoff) |

### Raw CLI subcommands

| Subcommand         | Typical argv pattern                          |
|--------------------|-----------------------------------------------|
| `issue list`       | `issue list --label ... --json ...`           |
| `issue view`       | `issue view <number> --json ...`              |
| `issue edit`       | `issue edit <number> ...`                     |
| `issue close`      | `issue close <number>`                        |
| `issue comment`    | `issue comment <number> --body ...`           |
| `label list`       | `label list --json ...`                       |
| `label create`     | `label create <name> --color ...`             |

## Extension rule

Downstream tests extend stub behavior **only** via per-test scenario files
stored at:

```
test/fixtures/issue-artifacts/scenarios/<test-name>.json
```

Tests MUST NOT patch the shim's argv parser or modify the stub scripts. All
behavioral variation flows through scenario files and environment variables.
