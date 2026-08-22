# TODO

This file is persistent and must not be deleted, even when there are no outstanding tasks.

- Add new TODOs only when the user explicitly asks for them.
- Remove a TODO as soon as the agent finishes the requested work; do not leave completed TODOs here.
- Keep this file actively updated so it lists only unfinished, explicitly requested work.

## Security

- [ ] Complete the pairing-code security work for remote Core access:
  - Re-enable pairing only after the remote access flow is safe.
  - Ensure `/v1/health` never gives the session token to remote callers using Tailscale Serve; require pairing/device authentication instead.
  - Add regression tests for direct local access and remote/proxied access.
  - Update the relevant documentation and verification coverage.
