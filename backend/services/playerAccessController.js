/* Purpose: Adapt authenticated panel identities and Player Center profiles to the typed allowlist service. */

const { normalizeUsername } = require('../utils/username');

class PlayerAccessControllerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PlayerAccessControllerError';
    this.status = status;
    this.code = code;
  }
}

function createPlayerAccessController({ accessService, store, usersDb } = {}) {
  if (!accessService || typeof accessService.listGrants !== 'function'
    || typeof accessService.createGrant !== 'function'
    || typeof accessService.updateGrant !== 'function') {
    throw new TypeError('playerAccessController requires the typed access service');
  }
  if (!store || typeof store.getPlayer !== 'function') throw new TypeError('playerAccessController requires the player store');
  if (!usersDb || typeof usersDb.listUsers !== 'function') throw new TypeError('playerAccessController requires usersDb');

  async function userDirectory() {
    const users = await usersDb.listUsers();
    return {
      byId: new Map(users.map(user => [Number(user.id), user])),
      byName: new Map(users.map(user => [String(user.username_normalized || normalizeUsername(user.username)), user]))
    };
  }

  function publicGrant(grant, directory) {
    if (!grant) return null;
    const sponsorUserId = Number(grant.sponsorUserId || grant.sponsoredBy);
    const createdByUserId = Number(grant.createdByUserId || grant.createdBy);
    return {
      ...grant,
      sponsorUserId: Number.isSafeInteger(sponsorUserId) ? sponsorUserId : null,
      sponsoredBy: Number.isSafeInteger(sponsorUserId) && directory.byId.get(sponsorUserId)
        ? directory.byId.get(sponsorUserId).username
        : null,
      createdByUserId: Number.isSafeInteger(createdByUserId) ? createdByUserId : null,
      createdBy: Number.isSafeInteger(createdByUserId) && directory.byId.get(createdByUserId)
        ? directory.byId.get(createdByUserId).username
        : null
    };
  }

  async function list({ serverId } = {}) {
    const [grants, directory] = await Promise.all([
      accessService.listGrants({ serverId }),
      userDirectory()
    ]);
    return {
      serverId,
      grants: grants.map(grant => publicGrant(grant, directory))
    };
  }

  async function create({
    serverId,
    actor,
    playerUuid,
    kind,
    startsAt,
    expiresAt,
    sponsor,
    reason,
    idempotencyKey = null
  } = {}) {
    const [profile, directory] = await Promise.all([
      store.getPlayer({ serverId, uuid: playerUuid }),
      userDirectory()
    ]);
    if (!profile || !profile.currentName) {
      throw new PlayerAccessControllerError(
        409,
        'ACCESS_PLAYER_NAME_UNRESOLVED',
        'A current server-observed player name is required before access can be granted.'
      );
    }
    let sponsorUser;
    try {
      sponsorUser = directory.byName.get(normalizeUsername(sponsor));
    } catch (_) {
      sponsorUser = null;
    }
    if (!sponsorUser || sponsorUser.disabled) {
      throw new PlayerAccessControllerError(
        400,
        'ACCESS_SPONSOR_INVALID',
        'Sponsor must be an active panel account.'
      );
    }
    const result = await accessService.createGrant({
      serverId,
      player: { uuid: profile.uuid, name: profile.currentName },
      type: kind,
      startsAt,
      expiresAt,
      createdBy: actor,
      sponsoredBy: sponsorUser,
      reason,
      idempotencyKey
    });
    return {
      ...result,
      grant: publicGrant(result.grant, directory)
    };
  }

  async function patch({ serverId, actor, grantId, patch } = {}) {
    // Resolve presentation-only dependencies before the access mutation so a
    // later directory outage can never turn a committed write into a 5xx.
    const directory = await userDirectory();
    const result = await accessService.updateGrant({
      serverId,
      grantId,
      actor,
      ...patch
    });
    return {
      ...result,
      grant: publicGrant(result.grant, directory)
    };
  }

  return { create, list, patch };
}

module.exports = {
  PlayerAccessControllerError,
  createPlayerAccessController
};
