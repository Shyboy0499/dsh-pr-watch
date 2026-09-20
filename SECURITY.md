# Security Policy

## Scope

`dsh-pr-watch` shells out to the GitHub CLI (`gh`) using your existing
authentication. Installing any dsh plugin executes third-party code in your
Harness environment — review the source before installing.

## Reporting a vulnerability

Do **not** open a public issue for security vulnerabilities.

Report privately via GitHub's private vulnerability reporting, or open an
advisory at:

https://github.com/Shyboy0499/dsh-pr-watch/security/advisories

## Security design

- `gh` is invoked with `child_process.spawn` using argument arrays and
  `shell: false` — never a shell string — so command injection via tool
  parameters is not possible.
- The plugin never reads, stores, or transmits credentials. It relies entirely on
  the `gh` CLI's own keyring-backed authentication.
- The snapshot contains only public pull-request metadata (title, URL,
  timestamps) and is written under `$DSH_HOME` or `~/.dsh`.
- No network requests are made outside the `gh` invocations.
