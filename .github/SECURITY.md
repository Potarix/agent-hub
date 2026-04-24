# Security Policy

## Supported versions

We support the latest released version of Agent Hub. Older versions may receive fixes for critical vulnerabilities only.

| Version | Supported |
|---------|-----------|
| 1.x     | ✓         |
| < 1.0   | —         |

## Reporting a vulnerability

**Please do not open a public issue.**

If you discover a security vulnerability in Agent Hub, email **omar.dadabhoy@gmail.com** with:

- A description of the issue
- Steps to reproduce (or a proof of concept)
- The impact you've observed or believe is possible
- Your name/handle if you'd like credit in the release notes

You'll get an acknowledgement within 72 hours. A fix timeline depends on severity, but critical issues are treated as the team's top priority.

## Scope

In scope:

- The Agent Hub macOS app (main process, renderer, preload)
- The `providers/` directory
- How Agent Hub handles API keys, SSH credentials, and tool approvals

Out of scope (please report to the upstream project):

- The underlying agent CLIs (`claude`, `codex`, `hermes`, `openclaw`)
- Vulnerabilities in Electron itself
- Third-party model providers (Anthropic, OpenAI, etc.)

## Disclosure

We practice coordinated disclosure. Please give us a reasonable window to ship a fix before going public — typically 30 days for high-severity issues.
