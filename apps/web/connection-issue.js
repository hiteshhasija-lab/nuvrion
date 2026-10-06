// Plain-English status line for a failing connection card: why it is failing, when it last worked, and when
// Nuvrion will try again. Pure functions (the DOM is only touched by startRetryCountdowns) so they can be tested in node.
const REASONS = {
  NUV_ESXI_UNREACHABLE: 'Host unreachable',
  NUV_WORKSTATION_UNREACHABLE: 'Host unreachable',
  NUV_WORKSTATION_UNAVAILABLE: 'Workstation unavailable',
  NUV_AGENT_OFFLINE: 'Workstation agent offline',
  NUV_AGENT_AUTH_FAILED: 'Agent authentication failed',
  NUV_VMWARE_TLS_REQUIRED: 'The host requires TLS'
};

export function failureReason(code) {
  if (!code) return 'Connection failing';
  if (REASONS[code]) return REASONS[code];
  const words = code.replace(/^NUV_/, '').toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function retryText(nextRetryAt, now = Date.now()) {
  const seconds = Math.round((Date.parse(nextRetryAt) - now) / 1000);
  if (!(seconds > 0)) return 'retrying now';
  return seconds < 60 ? `next retry in ${seconds}s` : `next retry in ${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function connectionIssueHtml(connection, { esc, when, now = Date.now() }) {
  if (connection.status === 'deleted' || !['critical', 'unhealthy'].includes(connection.healthState)) return '';
  const failures = connection.consecutiveFailures ?? 0;
  const details = [connection.lastSuccessAt ? `Last successful sync ${when(connection.lastSuccessAt)}` : 'Never synced successfully'];
  if (failures) details.push(`${failures} failed attempt${failures === 1 ? '' : 's'}`);
  if (connection.nextRetryAt) details.push(`<span data-retry-at="${esc(connection.nextRetryAt)}">${retryText(connection.nextRetryAt, now)}</span>`);
  return `<div class="connection-issue" role="status"><strong>${esc(failureReason(connection.lastErrorCode))}</strong><span>${details.join(' · ')}</span></div>`;
}

// The list re-renders every few seconds; between renders keep the countdown ticking.
export function startRetryCountdowns(root = document) {
  setInterval(() => {
    root.querySelectorAll('[data-retry-at]').forEach(node => { node.textContent = retryText(node.dataset.retryAt); });
  }, 1000);
}
