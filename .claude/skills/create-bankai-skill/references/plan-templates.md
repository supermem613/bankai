# Plan templates

## Dev-loop plan template

```jsonc
{
  "schemaVersion": "1",
  "name": "local-dev-loop",
  "requires": {
    "bindings": {
      "workspace": { "type": "path", "required": true }
    }
  },
  "steps": [
    {
      "kind": "attached-process",
      "id": "dev",
      "registerAs": "local-dev-loop",
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": { "binding": "workspace" },
      "timeoutMs": 600000,
      "readyWhen": [
        { "id": "ready-line", "stream": "stdout", "contains": "ready" }
      ],
      "failWhen": [
        { "id": "compile-failed", "stream": "any", "contains": "Compilation failed" }
      ],
      "verifyReady": [
        { "kind": "port", "id": "app", "host": "127.0.0.1", "port": 3000 }
      ]
    }
  ]
}
```

Run with a bindings file or inline object shorthand:

```powershell
bankai run plans\local-dev-loop.json --bindings-json '{"workspace":"C:\\repo"}'
```

## Test plan template

```jsonc
{
  "schemaVersion": "1",
  "name": "workflow-smoke",
  "requires": {
    "bindings": {
      "workspace": { "type": "path", "required": true }
    }
  },
  "steps": [
    {
      "kind": "shell",
      "id": "run-workflow",
      "command": "npm",
      "args": ["test"],
      "cwd": { "binding": "workspace" },
      "timeoutMs": 120000
    },
    {
      "kind": "assert",
      "id": "test-output",
      "assertion": "step-output-contains",
      "config": {
        "stepId": "run-workflow",
        "stream": "stdout",
        "text": "pass"
      }
    }
  ]
}
```
