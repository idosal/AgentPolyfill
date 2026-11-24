// The relay's wire format, from the relay Worker itself. The Worker's source ships inside the
// Claude Code mod, which deploys it from its own folder, so it stays there; this is the one place
// the shared client names that folder.
export * from '../../claude-code/mod/relay/src/protocol.ts';
