# Pi Grunt

Bounded standalone worker orchestration for [Pi](https://pi.dev). Grunt hands a single
bounded packet to a discrete sub-agent (`scout`, `implementer`, `verifier`, or `worker`)
and brings back a compact handoff, while the primary session stays the orchestrator,
decision-maker, and final reviewer.

Ships:
- **Extension** — the `grunt` and `grunt_control` tools, plus `/grunt-swap`, `/grunt-status`,
  `/grunt-steer`, `/grunt-cancel`, `/grunt-resume`, and `/grunt-answer` commands.
- **Skill** — `/skill:grunt` operator guide (launch, packet format, profiles, lifecycle).
- **Agent profiles** — the four worker prompts this package loads.

## Install

```bash
pi install git:github.com/<you>/pi-grunt@v1
```

## Usage

From any session, ask Pi to use Grunt, or invoke `grunt` directly with a bounded packet
(`GOAL`, `SCOPE`, `AUTHORITY`, `INPUTS`, `CONSTRAINTS`, `VALIDATION`, `OUTPUT`). Pick the
narrowest profile: `scout` (read-only) for discovery, `implementer` for authorized edits,
`verifier` for read-only tests/review, `worker` for legacy mixed access.

`scout` runs may overlap; writing profiles are serialized because they share the checkout.
Set the worker model once with `/grunt-swap`.

## Security

This package is an extension and executes arbitrary code in agent sub-processes on your
machine. Review the source before installing and keep authority/scope tight in every packet.

## License

MIT.
