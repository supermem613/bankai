# bankai/.bankai/plans/

Scenario specs that the bankai engine runs. Each `*.test.json` file is a
self-contained, schema-validated scenario. State is never written here:
iteration state goes to `.bankai/state/` (gitignored) and run artifacts go
to the session-state folder under HOME.

Run any scenario with:

```powershell
bankai test run .bankai/plans/<name>.test.json
bankai test run .bankai/plans/<name>.test.json --json   # machine envelope
```

The exit code is 0 on pass and 1 on failure. The `--json` envelope's
`failure.stage` field tells you which phase aborted: `validation`,
`env-setup`, `step`, `assertion`, or `env-teardown`.
