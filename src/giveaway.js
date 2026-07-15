const { getUser, updateUser, issueGiveawaySerial } = require('./db');

// ===================================================================
// "РОЗЫГРЫШ 1000 ЗВЁЗД" — invite-to-enter giveaway. Inviting someone new
// (via the referral link) earns the INVITER one numbered ticket in the
// draw; hitting GIVEAWAY_MIN_INVITES qualifies them to actually win.
// More invites past the minimum = more tickets = better odds, so the
// count is never capped once qualified.
// ===================================================================
const GIVEAWAY_MIN_INVITES = 3;
const GIVEAWAY_TITLE = 'РОЗЫГРЫШ 1000 ЗВЁЗД';
const GIVEAWAY_REMINDER_TEXT =
  '🎟 Напоминаем: в «Подполье» идёт розыгрыш 1000 звёзд.\n\nЗатащи 3 человек в дело — участвуешь. Больше людей — больше шансов, лимита нет.\n\nПроверить свой прогресс: вкладка «Позвать».';

function giveawayStatus(user) {
  const invites = user.giveaway_invites || 0;
  return {
    invites,
    min: GIVEAWAY_MIN_INVITES,
    qualified: invites >= GIVEAWAY_MIN_INVITES,
    serials: user.giveaway_serials || [],
  };
}

// Called the moment a NEW player joins via someone's referral link (see
// bot.js). Issues the inviter one fresh raffle ticket and bumps their
// count. Returns the new serial + running total so the caller can relay
// it to the admins — this is the only place serials get issued.
function recordGiveawayInvite(inviterId) {
  const inviter = getUser(inviterId);
  if (!inviter) return null;
  const serial = issueGiveawaySerial();
  const serials = [...(inviter.giveaway_serials || []), serial];
  const invites = (inviter.giveaway_invites || 0) + 1;
  updateUser(inviterId, { giveaway_invites: invites, giveaway_serials: serials });
  return { serial, invites, qualified: invites >= GIVEAWAY_MIN_INVITES };
}

module.exports = { GIVEAWAY_MIN_INVITES, GIVEAWAY_TITLE, GIVEAWAY_REMINDER_TEXT, giveawayStatus, recordGiveawayInvite };
