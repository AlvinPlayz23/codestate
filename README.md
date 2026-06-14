# Codestate

Codestate is a local AI coding-agent tool. Run `codestate` inside any project to start a local Hono server and open a browser UI connected to that project.

## Development

```bash
pnpm install
pnpm build
pnpm codestate
```

If you are running Codestate from another project through this repo, pass the target project explicitly:

```powershell
pnpm --dir C:/Users/bijim/codestate codestate --project $PWD
```

The CLI resolves the project root in this order:

```txt
--project
CODESTATE_PROJECT_ROOT
INIT_CWD
process.cwd()
```

## AI Provider

Codestate uses an OpenAI-compatible cloud API.

Create `.env.local` in the Codestate root directory:

```env
CODESTATE_API_KEY=your-key
CODESTATE_MODEL=gpt-4.1
CODESTATE_BASE_URL=https://api.openai.com/v1
```

Existing shell environment variables and CLI flags take precedence over Codestate's `.env.local`.

The agent tools are `read`, `list`, `search`, `write`, `apply`, and `run`.
