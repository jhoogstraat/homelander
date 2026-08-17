// Homelander — Main App component.
// Tab-based navigation: Searches, History, Settings.

import React, { useEffect, useState, useCallback } from 'react';
import { useStore } from './stores/appStore';
import SearchTab from './screens/SearchTab';
import HistoryTab from './screens/HistoryTab';
import SettingsTab from './screens/SettingsTab';
import SetupWizard from './screens/SetupWizard';
import StatusDot from './components/StatusDot';
import { LocaleProvider, useLocale } from './locales/LocaleContext';
import { userErrorText } from './shared/userErrors';
import { normalizeStats } from './shared/normalizeStats.js';
import { swallow } from './shared/logCatch.js';
import homelanderKey from './assets/homelander-key.png';

const TABS = ['searches', 'history', 'settings'];

export default function App() {
  return React.createElement(LocaleProvider, null, React.createElement(AppInner));
}

function AppInner() {
  const { t } = useLocale();
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setupComplete = useStore((s) => s.setupComplete);
  const daemonStatus = useStore((s) => s.daemonStatus);
  const setSetupComplete = useStore((s) => s.setSetupComplete);
  const setConfig = useStore((s) => s.setConfig);
  const setDaemonStatus = useStore((s) => s.setDaemonStatus);
  const setAppVersion = useStore((s) => s.setAppVersion);
  const setStats = useStore((s) => s.setStats);
  const addActivity = useStore((s) => s.addActivity);
  const setFilters = useStore((s) => s.setFilters);

  // Load initial state from Electron main process
  useEffect(() => {
    async function init() {
      if (!window.homelander) return;

      const config = await window.homelander.getConfig();
      setConfig(config);
      if (config._setupComplete) {
        setSetupComplete(true);
      }

      const [{ stats: allTimeStats, recent, error }, { stats: todayStats }] = await Promise.all([
        window.homelander.getStats(),
        window.homelander.getTodayStats(),
      ]);
      if (!error && todayStats) {
        setStats(normalizeStats(todayStats));
      }
      if (!error && recent) {
          for (const item of [...recent].reverse()) {
            addActivity({
              outcome: item.outcome,
              exposeId: item.expose_id || item.exposeId,
              title: item.title,
              price: item.price,
              size: item.size,
              address: item.address,
              detail: item.detail,
              failureReason: item.failure_reason || item.failureReason,
              time: item.sent_at,
              imageUrl: item.image_url,
            });
          }
      }

      const { filters } = await window.homelander.getFilters();
      if (filters) setFilters(filters);

      const { status, version } = await window.homelander.getDaemonStatus();
      setDaemonStatus(status);
      if (version) setAppVersion(version);
    }
    init();
  }, []);

  // Listen for daemon events
  useEffect(() => {
    if (!window.homelander) return;

    const unsubs = [];

    unsubs.push(window.homelander.onStats((data) => {
      if (data?.daemonStatus) setDaemonStatus(data.daemonStatus);
      setStats(normalizeStats(data));
      // Refresh per-search counts so FilterCards stay live
      window.homelander.getFilters().then(({ filters }) => {
        if (filters) setFilters(filters);
      }).catch((err) => { swallow(err, 'renderer/getFilters-refresh'); });
    }));

    unsubs.push(window.homelander.onListing((data) => {
      addActivity({
        outcome: data.outcome,
        exposeId: data.exposeId,
        title: data.title,
        price: data.price,
        size: data.size,
        address: data.address,
        detail: data.detail,
        failureReason: data.failureReason,
        time: data.sentAt || new Date().toISOString(),
        imageUrl: data.imageUrl,
      });
    }));

    unsubs.push(window.homelander.onEvent((data) => {
      if (data.type === 'daemon_started') setDaemonStatus('running');
      if (data.type === 'daemon_restarting') setDaemonStatus('restarting');
      if (data.type === 'paused') setDaemonStatus('paused');
      if (data.type === 'resumed') setDaemonStatus('running');
      if (data.type === 'daemon_stopped') setDaemonStatus('stopped');
      if (data.type === 'session_expired') {
        setDaemonStatus('session_expired');
        if (useStore.getState().stats.duplicateProtectionStatus === 'checking') {
          setStats(normalizeStats({ ...useStore.getState().stats, duplicateProtectionStatus: 'failed', messengerSyncError: data.reason || 'SESSION_EXPIRED' }));
        }
      }
      if (data.type === 'perimeter_captcha') {
        setDaemonStatus('perimeter_captcha');
        if (useStore.getState().stats.duplicateProtectionStatus === 'checking') {
          setStats(normalizeStats({ ...useStore.getState().stats, duplicateProtectionStatus: 'failed', messengerSyncError: data.reason || 'PERIMETER_CAPTCHA' }));
        }
      }
      if (data.type === 'nachrichten_sync_checking') {
        setStats(normalizeStats({ ...useStore.getState().stats, duplicateProtectionStatus: 'checking', messengerSyncError: null }));
      }
      if (data.type === 'nachrichten_sync_complete') {
        setStats(normalizeStats({
          ...useStore.getState().stats,
          duplicateProtectionStatus: 'active',
          messengerCheckedAt: new Date().toISOString(),
          messengerExposeIdsSeen: data.seen || 0,
          messengerConversationsChecked: data.seen || 0,
          messengerPendingRowsProtected: data.protected || 0,
          messengerNewFutureSkips: data.future_skips || 0,
          messengerPagesScanned: data.pages || 0,
          messengerSource: data.source || 'api',
          messengerSyncError: null,
        }));
        window.dispatchEvent(new CustomEvent('homelander:nachrichten-sync-complete', { detail: data }));
      }
      if (data.type === 'nachrichten_sync_error') {
        setStats(normalizeStats({
          ...useStore.getState().stats,
          duplicateProtectionStatus: 'failed',
          messengerCheckedAt: new Date().toISOString(),
          messengerSyncError: data.error || data.reason,
        }));
      }
      if (data.type === 'config_applied') {
        if (data.daemonStatus) setDaemonStatus(data.daemonStatus);
        // Brief flash — clears after animation
        window.dispatchEvent(new CustomEvent('homelander:config-applied'));
      }
      if (data.type === 'retry_queued') {
        window.dispatchEvent(new CustomEvent('homelander:retry-queued', { detail: { exposeId: data.exposeId } }));
      }
      if (data.type === 'poll_complete') {
        window.dispatchEvent(new CustomEvent('homelander:poll-complete', { detail: data }));
      }
    }));

    return () => unsubs.forEach(fn => fn());
  }, []);

  // Session recovery is user-confirmed. Do not poll IS24 login pages: the login
  // flow is bot-sensitive, so Homelander only opens the plain login browser and
  // trusts the user to click the header button again after IS24 visibly shows
  // them as logged in.

  // ── Daemon controls (global, visible from all tabs) ──────────
  const [daemonError, setDaemonError] = useState(null);

  const daemonControlDisabled = daemonStatus === 'restarting';

  const handleToggleDaemon = useCallback(async () => {
    if (!window.homelander) return;
    try {
      let keepMessage = false;
      if (daemonStatus === 'stopped') {
        const result = await window.homelander.startDaemon();
        if (result?.error) throw result;
        setDaemonStatus(result.status || 'running');
      } else if (daemonStatus === 'running') {
        const result = await window.homelander.pauseDaemon();
        if (result?.error) throw result;
        setDaemonStatus(result.status || 'paused');
      } else if (daemonStatus === 'session_expired' || daemonStatus === 'perimeter_captcha') {
        if (daemonStatus === 'perimeter_captcha') {
          // Captcha page is already loaded in the Chromium tab —
          // just bring it to front so the user can solve it.
          await window.homelander.focusBrowser();
          return;
        }
        const chromeStatus = await window.homelander.getChromeStatus();
        if (chromeStatus?.manualLogin && !chromeStatus?.cdpHealthy) {
          const finalize = await window.homelander.finalizeManualLogin();
          if (finalize?.error) throw finalize;
          const result = await window.homelander.resumeDaemon();
          if (result?.error) throw result;
          setDaemonStatus(result.status || 'running');
        } else if (chromeStatus?.cdpHealthy) {
          // CDP Chrome is running — open a fresh IS24 tab and bring it to front.
          // openLoginPage detects healthy CDP and navigates a new tab instead of restarting.
          const result = await window.homelander.openLoginPage();
          if (result?.error) throw result;
          setDaemonError(null);
        } else {
          const result = await window.homelander.openLoginPage();
          if (result?.error) throw result;
          setDaemonError(null);
        }
      } else if (daemonStatus === 'paused') {
        const result = await window.homelander.resumeDaemon();
        if (result?.error) throw result;
        setDaemonStatus(result.status || 'running');
      }
      if (!keepMessage) setDaemonError(null);
    } catch (err) {
      setDaemonError(userErrorText(err.userError || err, { operation: 'daemon action' }, t));
    }
  }, [daemonStatus, setDaemonStatus]);

  const handleStopDaemon = useCallback(async () => {
    if (!window.homelander) return;
    try {
      const result = await window.homelander.stopDaemon();
      if (result?.error) throw result;
      setDaemonStatus(result.status || 'stopped');
      setDaemonError(null);
    } catch (err) {
      setDaemonError(userErrorText(err.userError || err, { operation: 'daemon stop' }, t));
    }
  }, [setDaemonStatus]);

  const handleResumeAfterExpired = useCallback(async () => {
    if (!window.homelander) return;
    try {
      const result = await window.homelander.resumeDaemon();
      if (result?.error) throw result;
      setDaemonStatus(result.status || 'running');
      setDaemonError(null);
    } catch (err) {
      setDaemonError(userErrorText(err.userError || err, { operation: 'daemon resume' }, t));
    }
  }, [setDaemonStatus]);

  // Show setup wizard on first launch (language is step 0)
  if (!setupComplete) {
    return <SetupWizard onComplete={() => setSetupComplete(true)} />;
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Titlebar (draggable region for macOS hiddenInset) */}
      <div className="titlebar" />

      {/* Header */}
      <header className="flex items-center justify-between px-5 pb-2">
        {/* Left: title + controls grouped */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <img src={homelanderKey} alt="" className="w-5 h-5 object-contain opacity-90" draggable={false} />
            <h1 className="text-lg font-semibold tracking-tight">{t('app.title', 'Homelander')}</h1>
          </div>
          <div
            className="flex items-center gap-3 px-2.5 py-1 rounded"
          >
          <StatusDot status={daemonStatus} />
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            {daemonStatus === 'running' ? t('status.active', 'Active')
              : daemonStatus === 'paused' ? t('status.paused', 'Paused')
              : daemonStatus === 'session_expired' ? t('status.loginNeeded', 'Login needed')
              : daemonStatus === 'perimeter_captcha' ? t('status.captchaNeeded', 'Solve captcha')
              : daemonStatus === 'restarting' ? t('status.restarting', 'Restarting…')
              : t('status.stopped', 'Stopped')}
          </span>
          <button
            className="flex items-center justify-center w-6 h-6 rounded-full cursor-pointer select-none transition-all"
            onClick={handleToggleDaemon}
            disabled={daemonControlDisabled}
            title={daemonStatus === 'stopped' ? t('daemon.start', 'Start') : daemonStatus === 'running' ? t('daemon.pause', 'Pause') : daemonStatus === 'session_expired' ? t('daemon.openChromium', 'Open Chromium to log in') : daemonStatus === 'perimeter_captcha' ? t('daemon.openChromiumCaptcha', 'Open Chromium to solve captcha') : daemonStatus === 'restarting' ? t('status.restarting', 'Restarting…') : t('daemon.resume', 'Resume')}
            style={{
              fontSize: '13px',
              background: daemonStatus === 'stopped' ? 'rgba(59,130,246,0.15)' : daemonStatus === 'running' ? 'rgba(245,158,11,0.18)' : daemonStatus === 'session_expired' ? 'rgba(239,68,68,0.14)' : daemonStatus === 'perimeter_captcha' ? 'rgba(245,158,11,0.18)' : daemonStatus === 'restarting' ? 'rgba(156,163,175,0.12)' : 'rgba(59,130,246,0.15)',
              color: daemonStatus === 'stopped' ? 'var(--accent)' : daemonStatus === 'running' ? 'var(--warning)' : daemonStatus === 'session_expired' ? 'var(--danger)' : daemonStatus === 'perimeter_captcha' ? 'var(--warning)' : daemonStatus === 'restarting' ? 'var(--text-muted)' : 'var(--accent)',
              opacity: daemonControlDisabled ? 0.4 : 1,
            }}
          >
            {daemonStatus === 'stopped' ? '▶' : daemonStatus === 'running' ? '⏸' : daemonStatus === 'session_expired' ? '↗' : daemonStatus === 'perimeter_captcha' ? '↗' : daemonStatus === 'restarting' ? '⏳' : '▶'}
          </button>
          {daemonStatus !== 'stopped' && daemonStatus !== 'restarting' && daemonStatus !== 'session_expired' && daemonStatus !== 'perimeter_captcha' && (
            <button
              className="flex items-center justify-center w-6 h-6 rounded-full cursor-pointer select-none transition-all"
              onClick={handleStopDaemon}
              title={t('daemon.stop', 'Stop')}
              style={{ fontSize: '13px', background: 'rgba(239,68,68,0.12)', color: 'var(--danger)' }}
            >
              ⏹
            </button>
          )}
          {daemonStatus === 'session_expired' && (
            <button
              className="flex items-center justify-center w-6 h-6 rounded-full cursor-pointer select-none transition-all"
              onClick={handleResumeAfterExpired}
              title={t('daemon.continue', 'Continue')}
              style={{ fontSize: '13px', background: 'rgba(59,130,246,0.15)', color: 'var(--accent)' }}
            >
              ▶
            </button>
          )}
          {daemonStatus === 'perimeter_captcha' && (
            <button
              className="flex items-center justify-center w-6 h-6 rounded-full cursor-pointer select-none transition-all"
              onClick={handleResumeAfterExpired}
              title={t('daemon.continueCaptcha', 'Continue (after solving captcha)')}
              style={{ fontSize: '13px', background: 'rgba(59,130,246,0.15)', color: 'var(--accent)' }}
            >
              ▶
            </button>
          )}
          {daemonError && (
            <span className="text-xs" style={{ color: 'var(--danger)' }}>{daemonError}</span>
          )}
        </div>
        </div>

        {/* Right: tabs */}
        <nav className="flex gap-1">
          {TABS.map((id) => (
            <button
              key={id}
              className={`tab ${activeTab === id ? 'active' : ''}`}
              onClick={() => setActiveTab(id)}
            >
              {t(`tabs.${id}`, id)}
            </button>
          ))}
        </nav>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto px-5 pb-5">
        {activeTab === 'searches' && <SearchTab />}
        {activeTab === 'history' && <HistoryTab />}
        {activeTab === 'settings' && <SettingsTab />}
      </main>

      {/* Footer */}
      <footer className="px-5 pb-4 text-center">
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); window.homelander?.openExternal('https://github.com/B1Z0N/'); }}
            style={{ color: 'var(--accent)', textDecoration: 'none', cursor: 'pointer' }}
            className="hover:underline"
          >
            Mykola Fedurko
          </a>
          {' '}{t('app.footer', '© 2026')}
        </p>
      </footer>
    </div>
  );
}
