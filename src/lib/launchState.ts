// True while the launcher is starting the game (verifying, updating, requesting a session). A running game is
// checked separately with is_game_running. The update popup stays away while either is the case.
let launching = false;

export function setLaunching(value: boolean): void {
  launching = value;
}

export function isLaunching(): boolean {
  return launching;
}
