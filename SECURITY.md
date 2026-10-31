# Security

## Reporting a vulnerability

Please report it privately, not in a public issue:

- **GitHub:** use [private vulnerability reporting](https://github.com/rowkery/rowkery/security/advisories/new) on `rowkery/rowkery`.
- **Email:** security@rowkery.com.

Say what you found, how to reproduce it, and which version you ran (**Rowkery › About Rowkery**). We aim to answer within a week and will tell you when a fix ships. Rowkery is in beta, so fixes go into the next release; there are no backports.

## In scope

- **MCP guard bypasses.** An agent running a statement the guard should refuse: a write, a second statement, a function that changes data, a table you didn't share, a masked column's value, or a query past its row and time limits.
- **Safe-mode bypasses.** A write that runs on a connection in Read-only, or without showing its SQL on a connection set to Confirm writes.
- **Writes without the user pressing Commit.** Any change to your data from a pending edit or an agent's proposal that you didn't commit yourself.
- **Credential leaks.** A database or SSH password, key passphrase or connection secret written to `config.json`, a log, an issue report, an agent's answer or anywhere else outside the keychain.

Out of scope: bugs that need someone who already controls your OS account (see below), and slow or heavy queries you run yourself against your own database.

## Threat model

- **Agents get read-only, guarded access.** An MCP client talks to `Rowkery --mcp`, which only sees the connections, databases and tables you share on the Agents page. Every statement is checked before it reaches the database and runs on a read-only session with row and time limits; every call is logged. An agent can propose a change, but nothing runs until you review its dry run and press Commit.
- **An agent with shell access is you.** An agent that can run commands (Claude Code, for example) runs as your OS user. It can read and edit anything you can, including Rowkery's `config.json` (which tables are shared, safe mode) and the proposal queue beside it. Rowkery can't stop that. It does treat the queue as untrusted: before the dry run and again before the commit, the app checks the connection, the tables and the SQL of a proposal against your current settings. If you don't want an agent to change your sharing settings, don't give it a shell.
- **Passwords live in the keychain.** On macOS, database and SSH passwords are kept in the macOS Keychain, never in `config.json`. Linux and Windows builds use the platform's secret store. Where no keychain is available (or `ROWKERY_CONFIG_DIR` is set, as tests do), secrets go to an encrypted file, `secrets.enc`, with its key in `secrets.key` beside `config.json`: that keeps them out of plain sight, not away from someone who can read your files.
