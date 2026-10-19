// Decides, from each polled state.json, whether the companion's pill should
// flash. Electron-free so it can be unit-tested (test/companion-block-watcher.test.js).
//
// The pill is a "you just got blocked" notice, not a status light: it appears
// when the user is actually blocked and goes away a few seconds later, rather
// than sitting in the corner for a whole 20-minute cool-down.
//
// A block is a new `blockedAt` value (stamped by the extension's
// redirectToBlock() for both a site running out mid-visit and a later attempt
// to open a locked site). Blocks that happened before the companion started
// are not replayed. For an older extension/host that never writes
// `blockedAt`, an unlocked -> locked change still counts as a block.
function createBlockWatcher(initialState) {
  const blockedAtOf = (s) => (s && typeof s.blockedAt === "number" && Number.isFinite(s.blockedAt) ? s.blockedAt : 0);
  let lastBlockedAt = blockedAtOf(initialState);
  let wasLocked = Boolean(initialState && initialState.locked);

  // Returns "flash" (show the pill now), "hide" (nothing is locked any more)
  // or null (leave it as it is).
  return function onState(state) {
    const locked = Boolean(state && state.locked);
    const blockedAt = blockedAtOf(state);
    let action = null;
    if (!locked) {
      action = wasLocked ? "hide" : null;
    } else if (blockedAt > lastBlockedAt) {
      action = "flash";
    } else if (!blockedAt && !wasLocked) {
      action = "flash"; // legacy writer without blockedAt
    }
    if (blockedAt > lastBlockedAt) lastBlockedAt = blockedAt;
    wasLocked = locked;
    return action;
  };
}

module.exports = { createBlockWatcher };
