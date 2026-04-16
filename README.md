# Agent Hub

Imessage for your AI Agents. Chat with your hermes, Openclaw, Codex, and claude code instances locally and across different VPS's.

![Agent Hub](https://img.shields.io/badge/version-1.0.0-blue)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

## 🚀 Quickstart

1. **Clone the repository**
```bash
git clone https://github.com/OmarDadabhoy/agenthub.git
cd agent-hub
```

2. **Install dependencies**
```bash
npm install
```

3. **Launch the application**
```bash
npm start
```

Or use the convenience launcher:
```bash
./launch.sh
```

To run in background (detached from terminal):
```bash
npm run start-bg
```

## 🔧 Configuration

### Adding AI Agents

When you launch Agent Hub, you can add agents by clicking the "+" button and configuring:

1. **Agent Name**: Custom display name
2. **Provider**: Select from available providers
3. **Configuration**: Provider-specific settings

### Provider Setup Guide

#### Claude Code
- **Local Mode**: Requires `claude` CLI installed
- **SSH Mode**: Requires SSH access to remote machine with Claude CLI
- **Permission Modes**:
  - `ask`: Prompt for each permission
  - `acceptEdits`: Auto-approve safe edits
  - `bypassPermissions`: Skip all checks (use cautiously)

#### Codex
- **Local Mode**: Uses OpenAI Codex SDK
- **SSH Mode**: Requires SSH access to remote machine with Codex CLI


#### Hermes
- **Local Mode**: Requires local Hermes installation
- **Remote Mode**: Connect to Hermes server

#### OpenClaw
- Requires OpenClaw CLI (`openclaw`)

## 📝 License

MIT License - see LICENSE file for details

## 👥 Author

**Omar Dadabhoy**

---

**Note**: This project is under active development. Features and APIs may change.

