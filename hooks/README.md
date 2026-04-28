# DSP hooks

Install project hooks:

```bash
./hooks/install-hooks.sh
```

Or via the main installer:

```bash
./install.sh --with-hooks
```

Installed hooks:

- `pre-commit` — staged DSP impact check, marker dry-run, graph validation.
- `pre-push` — graph validation, optional protocol export, optional tests.
- `dsp-check-staged.sh` — reusable staged change impact/marker report.
- `dsp-agent-review.sh` — generates review context reports for agents.

Reports are written to `.dsp/reports/`.

Environment flags:

| Variable | Effect |
|---|---|
| `DSP_HOOK_SKIP=1` | Skip all DSP hooks |
| `DSP_HOOK_AUTO_UPDATE=1` | Run `dsp update --changed-only` during pre-commit |
| `DSP_HOOK_REQUIRE_MARKERS=1` | Fail if `dsp markers apply --dry-run` would insert markers |
| `DSP_HOOK_EXPORT_PROTOCOL=0` | Skip protocol export during pre-push |
| `DSP_HOOK_RUN_TESTS=1` | Run `pnpm test` during pre-push |

Agent review pack:

```bash
./hooks/dsp-agent-review.sh "Review authentication refactor"
```
