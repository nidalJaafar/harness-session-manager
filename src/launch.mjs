export function canOpenTerminalWindow(environment = process.env) {
  if (environment.SSH_TTY || environment.SSH_CONNECTION) return false;
  return Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
}

export function newSessionLaunchMethod(environment = process.env) {
  return canOpenTerminalWindow(environment) ? 'window' : 'current';
}
