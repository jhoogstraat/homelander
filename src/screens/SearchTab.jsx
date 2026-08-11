// SearchTab — manages IS24 searches, stats, live feed, and daemon controls.

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useStore } from '../stores/appStore';
import { useLocale } from '../locales/LocaleContext';
import FilterCard from '../components/FilterCard';
import ActivityFeed from '../components/ActivityFeed';
import { userErrorText } from '../shared/userErrors';
import { normalizeStats } from '../shared/normalizeStats.js';

// StatBadge at module scope — stable component identity prevents React
// from unmounting/remounting DOM on every render (which kills tooltips).
const StatBadge = React.memo(function StatBadge({ label, value, color, tooltip, showTip, moveTip, hideTip }) {
  const hasTooltip = !!(tooltip && showTip);
  return (
    <div
      className="card px-4 py-3 flex items-center gap-3 min-w-0"
      style={{ minWidth: 110 }}
      onMouseEnter={hasTooltip ? (e) => showTip(tooltip, e) : undefined}
      onMouseMove={hasTooltip ? moveTip : undefined}
      onMouseLeave={hasTooltip ? hideTip : undefined}
    >
      <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span className="text-lg font-semibold" style={{ color: color || 'var(--text-primary)' }}>
        {value ?? 0}
      </span>
    </div>
  );
});

export default function SearchTab() {
  const { t } = useLocale();
  // ── Store ──────────────────────────────────────────────────────
  const filters = useStore((s) => s.filters);
  const setFilters = useStore((s) => s.setFilters);
  const stats = useStore((s) => s.stats);
  const daemonStatus = useStore((s) => s.daemonStatus);
  const setStats = useStore((s) => s.setStats);
  const pollErrors = useStore((s) => s.pollErrors);
  const setPollError = useStore((s) => s.setPollError);
  const clearPollError = useStore((s) => s.clearPollError);

  // ── Local state ────────────────────────────────────────────────
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tip, setTip] = useState(null);
  const activeTipTargetRef = useRef(null);

  const hideTip = useCallback(() => {
    activeTipTargetRef.current = null;
    setTip(null);
  }, []);

  const showTip = useCallback((text, e) => {
    if (!text || !e?.currentTarget) {
      hideTip();
      return;
    }
    activeTipTargetRef.current = e.currentTarget;
    setTip({ text, x: e.clientX, y: e.clientY });
  }, [hideTip]);

  const moveTip = useCallback((e) => {
    const target = activeTipTargetRef.current || e?.currentTarget;
    if (!target || !e) return;
    activeTipTargetRef.current = target;
    const rect = target.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    ) {
      hideTip();
      return;
    }
    setTip(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : null);
  }, [hideTip]);

  useEffect(() => {
    const handleWindowMouseMove = (e) => {
      const target = activeTipTargetRef.current;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        hideTip();
      }
    };

    const handleWindowBlur = () => {
      if (activeTipTargetRef.current) hideTip();
    };
    const handleWindowScroll = () => {
      if (activeTipTargetRef.current) hideTip();
    };

    window.addEventListener('mousemove', handleWindowMouseMove, true);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('scroll', handleWindowScroll, true);

    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove, true);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('scroll', handleWindowScroll, true);
    };
  }, [hideTip]);



  // ── Load filters on mount ──────────────────────────────────────
  const loadFilters = useCallback(async () => {
    if (!window.homelander) return;
    setLoading(true);
    setError(null);
    try {
      const { filters: fresh, error: apiError } = await window.homelander.getFilters();
      if (apiError) {
        setError(apiError);
      } else if (fresh) {
        setFilters(fresh);
        // Clear any stale poll errors when filters load successfully
        for (const f of fresh) {
          clearPollError(f.id);
        }
      }
    } catch (err) {
      setError(userErrorText(err.userError || err, { operation: 'filters load' }, t));
    } finally {
      setLoading(false);
    }
  }, [setFilters, clearPollError]);

  useEffect(() => {
    loadFilters();
  }, [loadFilters]);

  // Load today's stats and filters on mount, then every 30s.
  useEffect(() => {
    async function refresh() {
      if (!window.homelander) return;
      const [{ stats: fresh, error: statsErr }, { filters: freshFilters, error: filtErr }] = await Promise.all([
        window.homelander.getTodayStats(),
        window.homelander.getFilters(),
      ]);
      if (!statsErr && fresh) {
        setStats(normalizeStats(fresh));
        for (const f of (freshFilters || [])) clearPollError(f.id);
      }
      if (!filtErr && freshFilters) setFilters(freshFilters);
    }
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [setStats, setFilters, clearPollError]);

  // ── Filter actions ─────────────────────────────────────────────
  const handleAddFilter = useCallback(async (webUrl, name) => {
    if (!window.homelander) return;
    try {
      const { filter, error: apiError } = await window.homelander.addFilter(webUrl, name);
      if (apiError) {
        setError(apiError);
        return false;
      }
      if (filter) {
        setFilters([...filters, filter]);
      }
      setShowAddDialog(false);
      setError(null);
      return true;
    } catch (err) {
      setError(userErrorText(err.userError || err, { operation: 'search add' }, t));
      return false;
    }
  }, [filters, setFilters]);

  const handlePauseFilter = useCallback(async (id, enable) => {
    if (!window.homelander) return;
    try {
      const { error: apiError } = await window.homelander.updateFilter(id, { enabled: enable });
      if (apiError) {
        setPollError(id, userErrorText(apiError.userError || apiError, { operation: 'search update' }, t));
        return;
      }
      clearPollError(id);
      // Optimistic update
      setFilters(filters.map((f) =>
        f.id === id ? { ...f, enabled: enable } : f
      ));
    } catch (err) {
      setPollError(id, userErrorText(err.userError || err, { operation: 'search update' }, t));
    }
  }, [filters, setFilters, setPollError, clearPollError]);

  const handleRemoveFilter = useCallback(async (id) => {
    if (!window.homelander) return;
    try {
      const { error: apiError } = await window.homelander.removeFilter(id);
      if (apiError) {
        setError(apiError);
        return;
      }
      clearPollError(id);
      setFilters(filters.filter((f) => f.id !== id));
      setError(null);
    } catch (err) {
      setError(userErrorText(err.userError || err, { operation: 'search remove' }, t));
    }
  }, [filters, setFilters, clearPollError]);

  const handlePollNow = useCallback(async (id) => {
    if (!window.homelander) return { error: userErrorText('Backend unavailable', { code: 'BACKEND_UNAVAILABLE' }, t) };
    try {
      const result = await window.homelander.pollNow(id);
      if (!result?.ok) {
        const msg = userErrorText(result?.userError || result, { operation: 'poll search' }, t);
        setPollError(id, msg);
        return { ...result, error: msg };
      }
      clearPollError(id);
      const [{ filters: freshFilters }, { stats: freshStats }] = await Promise.all([
        window.homelander.getFilters(),
        window.homelander.getTodayStats(),
      ]);
      if (freshFilters) setFilters(freshFilters);
      if (freshStats) setStats(normalizeStats(freshStats));
      return result;
    } catch (err) {
      const msg = userErrorText(err.userError || err, { operation: 'poll search' }, t);
      setPollError(id, msg);
      return { error: msg };
    }
  }, [setFilters, setStats, setPollError, clearPollError]);

  // ── Countdown for next auto-poll ──────────────────────────────
  const [nextPollCountdown, setNextPollCountdown] = useState('');
  const [configAppliedFlash, setConfigAppliedFlash] = useState(false);

  // ── Config-applied flash ─────────────────────────────────────
  useEffect(() => {
    const handler = () => {
      setConfigAppliedFlash(true);
      setTimeout(() => setConfigAppliedFlash(false), 2000);
    };
    window.addEventListener('homelander:config-applied', handler);
    return () => window.removeEventListener('homelander:config-applied', handler);
  }, []);

  useEffect(() => {
    const pollingActive = daemonStatus === 'running' || daemonStatus === 'paused' || daemonStatus === 'session_expired' || daemonStatus === 'perimeter_captcha';
    if (!pollingActive || !stats.nextPollAt) { setNextPollCountdown(''); return; }
    function tick() {
      const diff = new Date(stats.nextPollAt) - Date.now();
      if (diff <= 0) return setNextPollCountdown('');
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setNextPollCountdown(`${m}m ${s}s`);
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [stats.nextPollAt, daemonStatus]);

  const lastMessengerCheckedAt = stats.messengerCheckedAt
    ? new Date(stats.messengerCheckedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  const totalSeen = stats.messengerExposeIdsSeen || 0;
  const newCount = stats.messengerNewFutureSkips || 0;
  const duplicateSummary = stats.duplicateProtectionStatus === 'checking'
    ? t('search.duplicateCheckingHelper', 'Bereits kontaktierte Anzeigen werden erkannt.')
    : stats.duplicateProtectionStatus === 'failed'
      ? t('search.duplicateFailedHelper', 'Wird nach dem Login automatisch geprüft.')
      : lastMessengerCheckedAt
        ? t('search.lastMessengerCheckNew', '{{new}} neu · {{protected}} insgesamt · {{time}}')
            .replace('{{new}}', newCount)
            .replace('{{protected}}', totalSeen)
            .replace('{{time}}', lastMessengerCheckedAt)
        : t('search.duplicateReadyHelper', 'Homelander prüft vor dem Versand deine IS24 Nachrichten.');

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6">
      {/* ── Stats row ──────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap mt-2">
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{t('search.today', 'Today')}</span>
        <StatBadge label={t('search.processed', 'Processed')} value={`${(stats.sent + stats.failed + (stats.deactivated || 0) + (stats.premium || 0))}/${stats.seen}`} color="var(--accent)" showTip={showTip} moveTip={moveTip} hideTip={hideTip} />
        <StatBadge label={t('search.sent', 'Sent')} value={stats.sent} color="var(--success)" showTip={showTip} moveTip={moveTip} hideTip={hideTip} />
        <StatBadge label={t('search.failed', 'Failed')} value={stats.failed} color="var(--danger)" showTip={showTip} moveTip={moveTip} hideTip={hideTip} />
        <StatBadge label={t('livefeed.deactivated', 'Deactivated')} value={stats.deactivated || 0} color="var(--text-muted)" tooltip={t('livefeed.deactivatedTip')} showTip={showTip} moveTip={moveTip} hideTip={hideTip} />
        <StatBadge label={t('livefeed.premium', 'Premium')} value={stats.premium || 0} color="#a855f7" tooltip={t('livefeed.premiumTip')} showTip={showTip} moveTip={moveTip} hideTip={hideTip} />
        <span className="w-px h-5 self-center" style={{ backgroundColor: 'var(--border)' }} />
        <StatBadge label={t('livefeed.captcha', 'Captcha')} value={stats.captcha || 0} color="#f59e0b" tooltip={t('livefeed.captchaTip')} showTip={showTip} moveTip={moveTip} hideTip={hideTip} />

        </div>

      {/* ── Error banner ──────────────────────────────────────── */}
      {error && (
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
          style={{
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            color: 'var(--danger)',
          }}
        >
          <span>⚠</span>
          <span className="flex-1">{error}</span>
          <button
            className="font-medium hover:underline"
            onClick={() => setError(null)}
          >
            {t('common.dismiss', 'Dismiss')}
          </button>
        </div>
      )}

      {/* ── Your searches ─────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
              {t('search.yourSearches', 'Deine Suchen')}
            </h2>
            {filters.length > 0 && nextPollCountdown && (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                · {t('search.nextPollIn', 'Next poll in {{time}}').replace('{{time}}', nextPollCountdown)}
              </span>
            )}
          </div>
          <button
            className="btn btn-primary text-sm"
            onClick={() => setShowAddDialog(true)}
          >
            + {t('search.addSearchButton', 'Add search')}
          </button>
        </div>

        {loading && filters.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('search.loadingSearches', 'Suchen werden geladen…')}
            </p>
          </div>
        ) : filters.length === 0 ? (
          <div className="card p-8 text-center">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('search.noSearchesConfigured', 'Noch keine Suchen eingerichtet.')}
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {t('search.noSearchesHint', 'Add an IS24 search URL to start auto-applying to new listings.')}
            </p>
            <button
              className="btn btn-primary mt-4 text-sm"
              onClick={() => setShowAddDialog(true)}
            >
              + {t('search.addFirstSearch', 'Add your first search')}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {filters.map((filter) => (
              <FilterCard
                key={filter.id}
                filter={filter}
                onPause={handlePauseFilter}
                onRemove={handleRemoveFilter}
                onPollNow={handlePollNow}
                pollError={pollErrors[filter.id] || null}
              />
            ))}
          </div>
        )}
        {filters.length > 0 && (
          <p
            className="flex items-center gap-1.5 mt-2 pt-1.5 text-xs cursor-default"
            style={{
              color: 'var(--text-muted)',
              margin: 0,
              borderTop: '1px solid var(--border)',
            }}
            onMouseEnter={(e) => showTip(t('search.duplicateNoDuplicatesTip', 'Prüft deine IS24 Nachrichten, wenn Homelander startet oder fortgesetzt wird. Bewerbungen, die du manuell gemacht hast, während Homelander pausiert oder gestoppt war, werden erkannt und übersprungen.'), e)}
            onMouseMove={moveTip}
            onMouseLeave={hideTip}
          >
            <span>🛡</span>
            <span>{duplicateSummary}</span>
          </p>
        )}
      </section>

      {/* ── Add search dialog ─────────────────────────────────── */}
      {showAddDialog && (
        <LazyAddSearchDialog
          onAdd={handleAddFilter}
          onCancel={() => setShowAddDialog(false)}
        />
      )}

      {/* ── Live feed ─────────────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
          Live feed
        </h2>
        <ActivityFeed />
      </section>

      {tip && (
        <div
          className="fixed pointer-events-none z-50 px-3 py-1.5 rounded-lg text-xs font-medium shadow-lg"
          style={{
            left: tip.x + 14,
            top: tip.y - 36,
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            maxWidth: 320,
            whiteSpace: 'normal',
          }}
        >
          {tip.text}
        </div>
      )}

    </div>
  );
}

// ── Lazy dialog loader ──────────────────────────────────────────
// Dynamic import so the dialog bundle is only loaded when needed.
function LazyAddSearchDialog({ onAdd, onCancel }) {
  const { t } = useLocale();
  const [Dialog, setDialog] = useState(null);

  useEffect(() => {
    let cancelled = false;
    import('./AddSearchDialog').then((mod) => {
      if (!cancelled) setDialog(() => mod.default);
    }).catch(() => {
      // Fallback: render inline dialog if the module doesn't exist yet
      if (!cancelled) setDialog(() => InlineAddDialog);
    });
    return () => { cancelled = true; };
  }, []);

  if (!Dialog) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
        <div className="card p-6">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{t('common.loading', 'Wird geladen…')}</p>
        </div>
      </div>
    );
  }

  return <Dialog onAdd={onAdd} onCancel={onCancel} />;
}

// ── Inline fallback dialog (used when AddSearchDialog.jsx is missing) ─
function InlineAddDialog({ onAdd, onCancel }) {
  const { t } = useLocale();
  const [webUrl, setWebUrl] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!webUrl.trim()) {
      setLocalError(t('search.enterSearchUrl', 'Bitte IS24-Such-URL eingeben'));
      return;
    }
    setSubmitting(true);
    setLocalError(null);
    try {
      const ok = await onAdd(webUrl.trim(), name.trim() || undefined);
      if (!ok) {
        setLocalError(t('search.addFailed', 'Could not add search'));
      }
    } catch {
      setLocalError(t('search.addFailed', 'Could not add search'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="card p-6 w-full" style={{ maxWidth: 480 }}>
        <h2 className="text-base font-semibold mb-4">{t('search.addSearch', 'Add IS24 Search')}</h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label
              className="block text-xs mb-1.5 font-medium"
              style={{ color: 'var(--text-secondary)' }}
            >
              {t('search.searchUrl', 'Such-URL')}
            </label>
            <input
              className="input"
              type="url"
              placeholder="https://www.immobilienscout24.de/Suche/..."
              value={webUrl}
              onChange={(e) => setWebUrl(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label
              className="block text-xs mb-1.5 font-medium"
              style={{ color: 'var(--text-secondary)' }}
            >
              {t('search.nameOptional', 'Name (optional)')}
            </label>
            <input
              className="input"
              type="text"
              placeholder={t('search.searchPlaceholder', 'e.g. Berlin 2-room')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {localError && (
            <p className="text-xs" style={{ color: 'var(--danger)' }}>
              ⚠ {localError}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 mt-2">
            <button
              type="button"
              className="btn btn-ghost text-sm"
              onClick={onCancel}
              disabled={submitting}
            >
              {t('search.cancel', 'Abbrechen')}
            </button>
            <button
              type="submit"
              className="btn btn-primary text-sm"
              disabled={submitting || !webUrl.trim()}
            >
              {submitting ? t('search.adding', 'Adding…') : t('search.addSearchButton', 'Add search')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
