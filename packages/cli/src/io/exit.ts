// Exit codes are a contract (docs/manual, "Exit codes"): every command
// returns one of these, never a bare number.
export const EXIT = {
  ok: 0,
  blocking: 1,
  // ocra login, logout and whoami: no usable ocra Cloud session.
  notSignedIn: 1,
  error: 2,
  incomplete: 3,
  // ocra generate: edits made, but the branch moved or cannot be written to.
  notCommitted: 3,
  interrupted: 130,
} as const;
