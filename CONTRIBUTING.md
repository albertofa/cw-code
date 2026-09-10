# Contributing

Thanks for contributing to cw-code.

## Before opening a change

- Check existing issues and pull requests to avoid duplicated work.
- Keep changes focused and explain user-visible behavior in the pull request.
- Do not include credentials, provider transcripts, build output, or local
  configuration in commits.

## Local workflow

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Use `pnpm dev` to exercise the Electron application locally. Provider-specific
manual testing requires the corresponding CLI to be installed and authenticated.

## Code conventions

- Keep CLI-specific behavior behind the `CliDriver` seam.
- Keep the IPC handler, preload bridge, renderer types, and store synchronized
  when changing the main-to-renderer contract.
- Prefer small, typed changes and graceful visible failures over silent fallback.
- Add tests for stable parsers, mappers, routing, and filesystem boundaries.

## Pull requests

Describe the problem, the solution, and the verification commands you ran.
Include screenshots or a short recording for meaningful UI changes.
