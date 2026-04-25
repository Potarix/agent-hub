# Contributing to Agent Hub

Thanks for your interest in contributing! Here's how to get started.

## Getting Started

1. Fork the repo
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/agent-hub.git`
3. Install dependencies: `npm install`
4. Create a branch: `git checkout -b my-feature`
5. Make your changes
6. Test locally: `npm start`
7. Commit and push: `git push origin my-feature`
8. Open a Pull Request

## Development

```bash
npm run dev    # Run with dev tools enabled
npm start      # Run normally
```

## Adding a New Provider

1. Create a new file in `providers/` (e.g., `providers/my-provider.js`)
2. Export `chat()` or `stream()` and `ping()` methods
3. Register IPC handlers in `main.js`
4. Add UI support in `index.html`

Look at existing providers for reference — `openai-compat.js` is a good starting point.

## Guidelines

- Keep PRs focused — one feature or fix per PR
- Test your changes locally before submitting
- Follow the existing code style
- Update the README if you're adding a new provider or feature

## Reporting Issues

Open an issue at https://github.com/Potarix/agent-hub/issues with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your OS and Node.js version

## Security

If you find a security vulnerability, please email omar.dadabhoy@gmail.com instead of opening a public issue.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
