# Permission Approval System for Claude Code in AgentHub

## Overview
The AgentHub now supports capturing and approving permission requests from Claude Code SDK. When Claude Code needs permission to perform certain actions (like file edits, command execution, etc.), AgentHub will now display these requests in the UI and allow you to approve or deny them.

## How It Works

### For Claude Code SDK Provider
When using the `claude-code` provider (not SSH), permission requests are now properly forwarded to the AgentHub UI:

1. **Automatic Approval Mode**: Set `permissionMode: 'acceptEdits'` in your agent configuration to automatically approve safe edits
2. **Interactive Approval Mode**: Set `permissionMode: 'ask'` to be prompted for each permission request
3. **Bypass Mode**: Set `permissionMode: 'bypassPermissions'` to skip all permission checks (use with caution)

### Permission Request Flow
1. Claude Code SDK requests permission for an action
2. AgentHub captures the request via the `permissionHandler`
3. The request is displayed in the UI with:
   - Tool name being invoked
   - Input parameters for the tool
   - Description of what will happen
4. You can either:
   - **Approve**: Allow the action to proceed
   - **Deny**: Block the action with a reason

### Configuration Example
```javascript
const agent = {
  name: 'Claude Code Agent',
  provider: 'claude-code',
  permissionMode: 'ask',  // or 'acceptEdits', 'bypassPermissions'
  model: 'claude-3-5-sonnet-20241022',
  workDir: '/path/to/project'
};
```

### UI Interaction
When a permission request appears:
- A modal or inline prompt will show the requested action
- Review the tool name and parameters
- Click "Approve" to allow or "Deny" to block
- The decision is sent back to Claude Code SDK
- The conversation continues based on your decision

## Important Notes

1. **Streaming Mode Required**: Permission approval only works in streaming mode. Non-streaming mode auto-approves for backward compatibility.

2. **SSH Mode**: For `claude-code-ssh` provider, permissions are handled by the CLI directly and cannot be intercepted by AgentHub.

3. **Codex Provider**: Currently uses `approvalPolicy: 'never'` by default and bypasses approval.

## Troubleshooting

### Permissions Not Appearing
- Ensure you're using streaming mode
- Check that `permissionMode` is not set to `'bypassPermissions'`
- Verify Claude Code SDK is properly installed

### Approval Not Working
- Check the browser console for errors
- Ensure the `requestId` matches between request and response
- Verify the IPC handlers are properly registered

## Technical Implementation

The permission system works through:
1. `permissionHandler` callback in Claude Code SDK options
2. IPC communication between main and renderer processes
3. `agent:permission-request` events sent to frontend
4. `agent:permission-response` events sent back to main process
5. Promise resolution to unblock the SDK

This allows for seamless integration of Claude Code's permission system within the AgentHub UI.