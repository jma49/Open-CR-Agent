// What Codex is started with: enough to find its sign-in (its home, the
// system keyring) and reach the network, and nothing else. An API key in the
// environment is left out on purpose: this runtime reviews on the user's
// Codex sign-in, never on a key that happens to be set.
const PASSED = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "CODEX_HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

// `config`: the runtime's `-c` overrides. A model provider declared there
// reads its key from the variable its env_key names, which is passed too.
export function codexEnv(
  env: Readonly<Record<string, string | undefined>>,
  config: readonly string[] = [],
): Record<string, string> {
  const keys = config.flatMap((c) => {
    const name = /^model_providers\.[^.=]+\.env_key="([A-Za-z_][A-Za-z0-9_]*)"$/.exec(c)?.[1];
    return name ? [name] : [];
  });
  const passed = new Set([...PASSED, ...keys]);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && passed.has(name)) out[name] = value;
  }
  return out;
}
