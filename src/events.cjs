'use strict';

const identifier = /^[A-Za-z0-9_-]{1,80}$/;
const signals = new Set([
  'start', 'approval', 'modelStart', 'modelCompleted', 'modelFailed',
  'modelCancelled', 'stop', 'interrupt', 'end',
]);

function validId(value) {
  return typeof value === 'string' && identifier.test(value);
}

function hookEvent(input, at = Date.now()) {
  if (!input || !validId(input.session_id)) return null;

  let kind;
  switch (input.hook_event_name) {
    case 'UserPromptSubmit': kind = 'start'; break;
    case 'PermissionRequest': kind = 'approval'; break;
    case 'Stop': kind = 'stop'; break;
    case 'Interrupt': kind = 'interrupt'; break;
    case 'SessionEnd': kind = 'end'; break;
    case 'PreModelRequest':
    case 'PostModelRequest':
      if (input.agent_id && input.agent_id !== input.session_id) return null;
      if (input.hook_event_name === 'PreModelRequest') {
        kind = 'modelStart';
      } else {
        kind = {
          completed: 'modelCompleted',
          failed: 'modelFailed',
          cancelled: 'modelCancelled',
        }[input.status];
      }
      break;
    default: return null;
  }

  const event = {
    kind,
    sessionId: input.session_id,
    turnId: kind === 'end' ? null : input.turn_id,
    at,
  };
  return isEvent(event) ? event : null;
}

function isEvent(event) {
  return Boolean(event && signals.has(event.kind) && validId(event.sessionId)
    && (event.kind === 'end' ? event.turnId === null : validId(event.turnId))
    && Number.isFinite(event.at) && event.at >= 0);
}

module.exports = { hookEvent, isEvent };
