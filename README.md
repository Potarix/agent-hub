# Agent Hub

Imessage for your AI Agents. Chat with your hermes, Openclaw, Codex, and claude code instances locally and across different VPS's.

![Agent Hub](https://img.shields.io/badge/version-1.0.0-blue)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

## 🎯 Features

- **Multi-Provider Support**: Connect to AI providers including Claude Code, OpenAI, Codex, Hermes, and OpenClaw
- **Unified Interface**: Single dashboard to manage all your AI conversations
- **Streaming Responses**: Real-time streaming for supported providers
- **Permission Management**: Advanced permission approval system for Claude Code operations
- **SSH Remote Support**: Connect to remote AI agents via SSH
- **Slash Commands**: Built-in commands for common operations
- **Session Management**: Maintain conversation context across sessions

## 📋 Prerequisites

Before running Agent Hub, ensure you have the following installed:

### Required
- **Node.js** (v18 or higher)
- **npm** (comes with Node.js)
- **macOS** (currently optimized for Mac)

### Optional (depending on which providers you want to use)
- **Claude CLI**: For Claude Code provider (`npm install -g @anthropic-ai/claude-code`)
- **OpenClaw CLI**: For OpenClaw provider (`npm install -g openclaw`)
- **Codex CLI**: For Codex provider (`npm i -g @openai/codex`)
- **Hermes CLI**: For Hermes provider (installation varies)
- **SSH Access**: For remote provider connections

## 🚀 Installation

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

### Environment Variables

You can set these optional environment variables:

```bash
# For OpenAI-compatible providers
export OPENAI_API_KEY="your-api-key"

# For custom base URLs
export OPENAI_BASE_URL="https://your-api-endpoint.com"

# For SSH connections
export SSH_KEY_PATH="~/.ssh/id_rsa"
```

## 🎮 Usage

### Basic Chat
1. Select an agent from the sidebar
2. Type your message in the input field
3. Press Enter or click Send
4. View streaming responses in real-time

### Permission Approval (Claude Code)
When using Claude Code with permission mode enabled:
1. The agent will request permission for operations
2. Review the tool and parameters in the modal
3. Click "Approve" or "Deny" with optional reason
4. The operation proceeds based on your decision

### Slash Commands
Type `/` in the message input to see available commands:
- `/clear` - Clear conversation history
- `/reset` - Reset agent session
- `/export` - Export conversation
- `/settings` - Open agent settings

### Keyboard Shortcuts
- `Cmd+N` - New conversation
- `Cmd+,` - Open settings
- `Cmd+K` - Quick agent switcher
- `Cmd+/` - Toggle sidebar
- `Cmd+Shift+D` - Toggle dark mode

## 🏗️ Architecture

```
agent-hub/
├── main.js              # Electron main process
├── index.html           # React UI (single file)
├── preload.js           # Electron preload script
├── providers/           # AI provider implementations
│   ├── claude-code.js   # Claude Code SDK integration
│   ├── openai-compat.js # OpenAI API integration
│   ├── codex.js         # Codex provider
│   ├── hermes.js        # Hermes provider
│   └── openclaw.js      # OpenClaw provider
├── lib/                 # Utility modules
│   ├── state.js         # Application state management
│   ├── http.js          # HTTP utilities
│   └── ssh.js           # SSH connection handling
├── auth.js              # Authentication handlers
└── slash-commands.js    # Command processing
```

### Key Technologies
- **Electron**: Desktop application framework
- **React**: UI components (loaded via CDN)
- **Node.js**: Backend runtime
- **IPC**: Inter-process communication for main/renderer

## 🛠️ Development

### Running in Development Mode
```bash
npm run dev
```
This enables developer tools and hot reload.

### Project Structure
- **Main Process** (`main.js`): Handles system operations, provider communication
- **Renderer Process** (`index.html`): React-based UI
- **Providers**: Modular architecture for easy provider addition
- **IPC Handlers**: Secure communication between processes

### Adding New Providers
1. Create provider file in `providers/`
2. Implement required methods:
   - `chat()` or `stream()`
   - `ping()` for health checks
3. Register in `main.js` IPC handlers
4. Add UI support in `index.html`

## 🐛 Troubleshooting

### Application Won't Start
- Check Node.js version: `node --version` (should be v18+)
- Reinstall dependencies: `rm -rf node_modules && npm install`
- Check for port conflicts if using local providers

### Provider Not Working

Agent Hub does not install or manage AI agents for you — each provider must already be installed and running on your system before you can use it in Agent Hub.

**Claude Code**: Requires the `claude` CLI to be installed and authenticated.
```bash
# Verify it's available
which claude
```

**OpenClaw**: Requires the `openclaw` CLI to be installed and available in your PATH.
```bash
# Verify it's available
which openclaw
```

**Hermes**: Requires a running Hermes service.
```bash
# Verify the service is running
hermes --version
```

### Permission Requests Not Appearing
- Ensure streaming mode is enabled
- Check `permissionMode` is not set to `bypassPermissions`
- View console logs: `Cmd+Option+I` in developer mode

### SSH Connection Failed
- Verify SSH key permissions: `chmod 600 ~/.ssh/id_rsa`
- Test connection: `ssh user@host`
- Check firewall settings

### Dark Mode Not Working
- Check system preferences for appearance settings
- Manually toggle: `Cmd+Shift+D`

## 📝 License

MIT License - see LICENSE file for details

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 🔗 Links

- [Issue Tracker](https://github.com/OmarDadabhoy/agenthub/issues)
- [Documentation](https://github.com/OmarDadabhoy/agenthub/wiki)

## 👥 Author

**Omar Dadabhoy**

## 🙏 Acknowledgments

- Built on [Electron](https://www.electronjs.org/)
- UI powered by [React](https://reactjs.org/)
- Claude Code SDK by [Anthropic](https://www.anthropic.com/)
- OpenAI SDK for GPT models
- All the amazing AI provider teams

---

**Note**: This project is under active development. Features and APIs may change.

