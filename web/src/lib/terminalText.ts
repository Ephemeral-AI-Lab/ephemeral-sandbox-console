// The console renders line-oriented command output, not a PTY. Remove terminal
// control sequences at the data boundary so they cannot leak into any text UI.
const OPERATING_SYSTEM_COMMAND = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const CONTROL_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;
const ESCAPE_SEQUENCE = /\u001B[ -/]*[0-~]/g;
const NON_TEXT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export function stripTerminalControlSequences(output: string): string {
  return output
    .replace(OPERATING_SYSTEM_COMMAND, "")
    .replace(CONTROL_SEQUENCE, "")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(NON_TEXT_CONTROL, "");
}
