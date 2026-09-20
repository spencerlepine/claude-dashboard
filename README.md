# Claude Dashboard

A local, live dashboard for your [Claude Code](https://claude.com/claude-code) sessions — every running session on your machine, what it's doing right now, its sub-agent tree, scheduled jobs, and estimated cost.

https://github.com/user-attachments/assets/5793a0b5-856a-43d2-affb-14a854711c34

- **Live session list** — every Claude Code process on your machine, with status: `idle`, `working`, `permission` (waiting on you), or `question`.
- **Sub-agent tree** — nested `Agent` spawns, drawn as a tree, with per-agent status.
- **Scheduled jobs** — live cron jobs with next run time.
- **Estimated cost** — token usage across the main session and all sub-agents, priced at API list rates.

Everything is read from `~/.claude` on disk. Nothing leaves your machine.

## Installation

Requires [Node.js](https://nodejs.org) 20+ and Claude Code.

```bash
git clone https://github.com/spencerlepine/claude-dashboard.git
cd claude-dashboard
npm install
npm start
```

Then open **http://localhost:9000**. Start a Claude Code session in any terminal and it appears within a few seconds.

> `npm start` also opens Chrome for you (macOS). On Linux or Windows, use `npm run dev` and open the URL yourself.

## Configuration

| Variable            | Default     | Description                                                                    |
| ------------------- | ----------- | ------------------------------------------------------------------------------ |
| `PORT`              | `9000`      | Port the dashboard listens on.                                                 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Path to the global claude directory where sessions and transcripts are stored. |

```bash
PORT=3000 npm start
```

## Demo mode

Want to see it without running any sessions? Open **http://localhost:9000/?demo=true** for a scripted 60-second loop with mock sessions and sub-agents.

## Notes

- Cost is **estimated** at Anthropic API list prices. Once a session has ended it's the same total Claude Code's `/usage` reports (read from the transcript); while a session is running it's computed from token counts, which runs a few % low. If you're on a Pro or Max plan, you aren't billed per token, so treat it as a usage signal, not a bill.
- Reads the on-disk format of Claude Code 2.1.x. A future Claude Code release may change it. If it does, the dashboard keeps running with the affected fields blank, and the server log prints a `━━ claude-dashboard WARN|ERROR <CODE>` block for each problem: the file and line, expected vs. actual shape, a raw sample, the Claude Code version, and which API fields are affected. Paste that block into a coding agent to get a fix (see `server/diagnostics.ts`).

## License

MIT
