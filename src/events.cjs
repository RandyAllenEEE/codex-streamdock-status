'use strict';

const identifier = /^[A-Za-z0-9_-]{1,80}$/;
const signals = new Set([
  'start', 'approval', 'modelStart', 'modelCompleted', 'modelFailed',
  'modelCancelled', 'stop', 'interrupt', 'end',
  'questionStart', 'questionEnd',
]);
const TRANSCRIPT_PATH_BYTES = 1024;

function validTranscriptPath(value) {
  return typeof value === 'string' && value.length > 0
    && !/[\u0000-\u001f]/.test(value) && Buffer.byteLength(value) <= TRANSCRIPT_PATH_BYTES;
}

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
    case 'PreToolUse':
    case 'PostToolUse':
      if (input.tool_name !== 'request_user_input'
        || (input.agent_id && input.agent_id !== input.session_id)) return null;
      kind = input.hook_event_name === 'PreToolUse' ? 'questionStart' : 'questionEnd';
      break;
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
  if (kind === 'questionStart' || kind === 'questionEnd') event.toolUseId = input.tool_use_id;
  if (kind === 'stop' && validTranscriptPath(input.transcript_path)) {
    event.transcriptPath = input.transcript_path;
  }
  return isEvent(event) ? event : null;
}

function isEvent(event) {
  return Boolean(event && signals.has(event.kind) && validId(event.sessionId)
    && (event.kind === 'end' ? event.turnId === null : validId(event.turnId))
    && (event.kind === 'questionStart' || event.kind === 'questionEnd'
      ? validId(event.toolUseId) : event.toolUseId === undefined)
    && (event.transcriptPath === undefined
      || (event.kind === 'stop' && validTranscriptPath(event.transcriptPath)))
    && Number.isFinite(event.at) && event.at >= 0);
}

module.exports = { hookEvent, isEvent };
