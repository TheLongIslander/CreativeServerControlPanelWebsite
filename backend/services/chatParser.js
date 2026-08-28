/*
 * Purpose: Parse the small, explicit subset of Minecraft server-log lines that
 *          is safe to expose as panel chat/activity.
 *
 * This module is intentionally pure. Unknown and malformed input returns null.
 */

const MAX_RAW_LINE_BYTES = 64 * 1024;
const MAX_STORED_MESSAGE_CODE_POINTS = 8192;

const LOG_PREFIX = /^\[(\d{2}:\d{2}:\d{2})\] \[Server thread\/INFO\]: (.*)$/;
const PLAYER_NAME = '[A-Za-z0-9_]{1,16}';
const PLAYER_CHAT = new RegExp(`^(?:\\[Not Secure\\] )?<(${PLAYER_NAME})> (.+)$`);
const JOIN = new RegExp(`^(${PLAYER_NAME}) joined the game$`);
const LEAVE = new RegExp(`^(${PLAYER_NAME}) left the game$`);
const ADVANCEMENT = new RegExp(
  `^(${PLAYER_NAME}) (has made the advancement|has completed the challenge|has reached the goal) \\[([^\\]\\r\\n]+)\\]$`
);

// Match only anchored, known vanilla-style death templates after a validated
// player name. Entity/item suffixes remain data and are bounded by the raw-line
// and stored-message limits above.
const DEATH_SUFFIXES = [
  /^died$/,
  /^died because of .+$/,
  /^was slain by .+$/,
  /^was shot by .+$/,
  /^was killed by .+$/,
  /^was killed trying to hurt .+$/,
  /^was killed by magic$/,
  /^was killed by even more magic$/,
  /^fell from a high place$/,
  /^fell off (?:a ladder|some vines|some weeping vines|some twisting vines|scaffolding|while climbing)$/,
  /^fell too far and was finished by .+$/,
  /^was doomed to fall by .+$/,
  /^was blown from a high place by .+$/,
  /^hit the ground too hard(?: whilst trying to escape .+)?$/,
  /^tried to swim in lava(?: to escape .+)?$/,
  /^discovered the floor was lava(?: due to .+)?$/,
  /^fell out of the world(?: whilst fighting .+)?$/,
  /^suffocated in a wall(?: whilst fighting .+)?$/,
  /^drowned(?: whilst trying to escape .+)?$/,
  /^went up in flames$/,
  /^burned to death(?: whilst fighting .+)?$/,
  /^was burned to a crisp whilst fighting .+$/,
  /^walked into fire whilst fighting .+$/,
  /^walked into danger zone due to .+$/,
  /^was struck by lightning(?: whilst fighting .+)?$/,
  /^blew up$/,
  /^was blown up by .+$/,
  /^went off with a bang due to a firework fired from .+$/,
  /^experienced kinetic energy(?: whilst trying to escape .+)?$/,
  /^starved to death$/,
  /^froze to death$/,
  /^was frozen to death by .+$/,
  /^withered away(?: whilst fighting .+)?$/,
  /^was pricked to death(?: whilst trying to escape .+)?$/,
  /^walked into a cactus whilst trying to escape .+$/,
  /^was squashed by a falling (?:anvil|block)$/,
  /^was squished too much$/,
  /^was poked to death by .+$/,
  /^was stung to death$/,
  /^was pummeled by .+$/,
  /^was fireballed by .+$/,
  /^was skewered by .+$/,
  /^was impaled by .+$/,
  /^was impaled on a stalagmite$/,
  /^was roasted in dragon breath$/,
  /^was obliterated by a sonically-charged shriek$/,
  /^didn't want to live in the same world as .+$/,
  /^was killed while trying to hurt .+$/,
  /^was destroyed by .+$/
];

// ECMA-48 CSI sequences are the only terminal escapes Minecraft commonly adds.
// Do not attempt to interpret arbitrary escape/control sequences.
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function stripKnownAnsi(value) {
  return value.replace(ANSI_CSI, '');
}

function isStoredTextSafe(value) {
  return value.length > 0 && Array.from(value).length <= MAX_STORED_MESSAGE_CODE_POINTS;
}

function event(logTimeText, kind, actorName, message, metadata) {
  const result = {
    origin: 'minecraft',
    kind,
    actorName,
    message,
    logTimeText
  };
  if (metadata) {
    result.metadata = metadata;
  }
  return result;
}

function parseDeath(body, logTimeText) {
  const nameMatch = body.match(new RegExp(`^(${PLAYER_NAME}) (.+)$`));
  if (!nameMatch) {
    return null;
  }
  const actorName = nameMatch[1];
  const suffix = nameMatch[2];
  if (!DEATH_SUFFIXES.some(pattern => pattern.test(suffix))) {
    return null;
  }
  return event(logTimeText, 'death', actorName, suffix);
}

function parseMinecraftLogLine(input) {
  if (typeof input !== 'string') {
    return null;
  }

  // The tailer normally removes CR. Accepting one terminal CR keeps the pure
  // parser safe and convenient for direct CRLF fixtures.
  const withoutTerminalCr = input.endsWith('\r') ? input.slice(0, -1) : input;
  if (Buffer.byteLength(withoutTerminalCr, 'utf8') > MAX_RAW_LINE_BYTES) {
    return null;
  }

  const line = stripKnownAnsi(withoutTerminalCr);
  const prefix = line.match(LOG_PREFIX);
  if (!prefix) {
    return null;
  }

  const logTimeText = prefix[1];
  const body = prefix[2];
  let match = body.match(PLAYER_CHAT);
  if (match) {
    const message = match[2];
    return isStoredTextSafe(message)
      ? event(logTimeText, 'chat', match[1], message)
      : null;
  }

  match = body.match(JOIN);
  if (match) {
    return event(logTimeText, 'join', match[1], 'joined the game');
  }

  match = body.match(LEAVE);
  if (match) {
    return event(logTimeText, 'leave', match[1], 'left the game');
  }

  match = body.match(ADVANCEMENT);
  if (match) {
    const verb = match[2];
    const title = match[3];
    const message = `${verb} [${title}]`;
    return isStoredTextSafe(message)
      ? event(logTimeText, 'advancement', match[1], message, {
        advancementVerb: verb,
        advancementTitle: title
      })
      : null;
  }

  const death = parseDeath(body, logTimeText);
  return death && isStoredTextSafe(death.message) ? death : null;
}

module.exports = {
  parseMinecraftLogLine,
  stripKnownAnsi,
  MAX_RAW_LINE_BYTES,
  MAX_STORED_MESSAGE_CODE_POINTS
};
