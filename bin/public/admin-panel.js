    const W = window.WALLET;

    // ── Toast + confirm modals (replace native alert/confirm) ──────────────────
    function showToast(title, message, variant = 'info', opts = {}) {
      const modal = document.getElementById('toast-modal');
      const icon  = document.getElementById('toast-icon');
      const card  = document.getElementById('toast-card');
      const styles = {
        info:    { ring: 'border-blue-800',  iconBg: 'bg-blue-900/40  text-blue-300',  sym: 'ℹ', btn: 'bg-blue-600 hover:bg-blue-500' },
        success: { ring: 'border-green-800', iconBg: 'bg-green-900/40 text-green-300', sym: '✓', btn: 'bg-green-600 hover:bg-green-500' },
        error:   { ring: 'border-red-900',   iconBg: 'bg-red-900/40   text-red-300',   sym: '!', btn: 'bg-red-600 hover:bg-red-500' },
      };
      const s = styles[variant] ?? styles.info;
      card.className = card.className.replace(/border-(blue|green|red)-[0-9]+/g, '').trim();
      card.classList.add(s.ring);
      icon.className = `flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-lg font-bold ${s.iconBg}`;
      icon.textContent = s.sym;
      document.getElementById('toast-title').textContent = title;
      document.getElementById('toast-message').textContent = message;
      const okBtn = document.getElementById('toast-ok');
      okBtn.className = `w-full py-2.5 rounded-lg text-sm font-semibold transition-colors text-white ${s.btn}`;
      const link = document.getElementById('toast-link');
      if (opts.txHash && /^[0-9a-f]{64}$/i.test(opts.txHash)) {
        link.href = `https://cexplorer.io/tx/${opts.txHash}`;
        link.textContent = (opts.linkLabel ?? 'View transaction on cexplorer') + ' ↗';
        link.classList.remove('hidden');
      } else {
        link.classList.add('hidden');
      }
      modal.classList.remove('hidden');
    }
    function hideToast() { document.getElementById('toast-modal').classList.add('hidden'); }
    document.getElementById('toast-close').addEventListener('click', hideToast);
    document.getElementById('toast-ok').addEventListener('click', hideToast);
    document.getElementById('toast-modal').addEventListener('click', (e) => {
      if (e.target.id === 'toast-modal') hideToast();
    });

    // Promise-based replacement for native confirm(). Resolves true/false.
    // variant: 'info' (blue confirm) | 'danger' (red confirm)
    function showConfirm(title, message, variant = 'info') {
      return new Promise(resolve => {
        const modal = document.getElementById('confirm-modal');
        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-message').textContent = message;
        const okBtn = document.getElementById('confirm-ok');
        okBtn.className = `flex-1 py-2.5 rounded-lg text-sm font-semibold text-white ${variant === 'danger' ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'}`;
        modal.classList.remove('hidden');
        const done = (val) => {
          modal.classList.add('hidden');
          okBtn.replaceWith(okBtn.cloneNode(true));
          document.getElementById('confirm-cancel').replaceWith(document.getElementById('confirm-cancel').cloneNode(true));
          document.getElementById('confirm-cancel-x').replaceWith(document.getElementById('confirm-cancel-x').cloneNode(true));
          resolve(val);
        };
        document.getElementById('confirm-ok').addEventListener('click', () => done(true), { once: true });
        document.getElementById('confirm-cancel').addEventListener('click', () => done(false), { once: true });
        document.getElementById('confirm-cancel-x').addEventListener('click', () => done(false), { once: true });
      });
    }
    const loginScreen   = document.getElementById('login-screen');
    const adminPanel    = document.getElementById('admin-panel');
    const walletList    = document.getElementById('wallet-list');
    const loginStatus   = document.getElementById('login-status');
    const sessionInfo   = document.getElementById('session-info');
    const logoutBtn     = document.getElementById('logout-btn');

    // ── Check session on load ──────────────────────────────────────────────────
    async function checkSession() {
      try {
        const r = await fetch('/api/admin/auth/status');
        const { authenticated } = await r.json();
        if (authenticated) showPanel();
        else showLogin();
      } catch {
        showLogin();
      }
    }

    function showLogin() {
      loginScreen.classList.remove('hidden');
      adminPanel.classList.add('hidden');
      sessionInfo.classList.add('hidden');
      logoutBtn.classList.add('hidden');
      renderWalletList();
    }

    async function showPanel() {
      loginScreen.classList.add('hidden');
      adminPanel.classList.remove('hidden');
      sessionInfo.classList.remove('hidden');
      logoutBtn.classList.remove('hidden');
      sessionInfo.textContent = 'Session active';
      await loadMarkets();
    }

    // Escape any user/extension-controlled string before interpolating into
    // innerHTML. Covers admin-supplied market titles and wallet-extension names.
    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function renderWalletList() {
      const wallets = W.getAvailableWallets();
      if (!wallets.length) {
        walletList.innerHTML = `<div class="text-sm text-red-400">No Cardano wallets detected. Install Lace or Eternl.</div>`;
        return;
      }
      walletList.innerHTML = wallets.map(n => {
        const sn = escapeHtml(n);
        return `<button data-wallet="${sn}" class="wallet-connect-btn bg-blue-600 hover:bg-blue-500 px-4 py-3 rounded-lg text-sm font-semibold">${sn}</button>`;
      }).join('');
      walletList.querySelectorAll('.wallet-connect-btn').forEach(btn => {
        btn.addEventListener('click', () => loginWith(btn.dataset.wallet));
      });
    }

    // ── Login: connect → signData(challenge) → verify ──────────────────────────
    async function loginWith(walletName) {
      loginStatus.textContent = 'Connecting…';
      try {
        await W.connectWallet(walletName);

        loginStatus.textContent = 'Requesting challenge…';
        const chResp = await fetch('/api/admin/auth/challenge', { method: 'POST' });
        if (!chResp.ok) throw new Error('Failed to request challenge');
        const { nonce, payload } = await chResp.json();

        loginStatus.textContent = 'Please sign the login message in your wallet…';
        const addressHex = (await W.state.walletApi.getUsedAddresses())[0]
                       ?? (await W.state.walletApi.getUnusedAddresses())[0];
        const payloadHex = W.utf8ToHex(payload);
        const sig = await W.state.walletApi.signData(addressHex, payloadHex);

        loginStatus.textContent = 'Verifying…';
        const vResp = await fetch('/api/admin/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nonce, signature: sig.signature, key: sig.key }),
        });
        if (!vResp.ok) {
          const e = await vResp.json();
          throw new Error(e.error ?? 'Auth failed');
        }
        loginStatus.textContent = '';
        await showPanel();
      } catch (err) {
        console.error(err);
        loginStatus.textContent = '❌ ' + (err.message ?? String(err));
      }
    }

    logoutBtn.addEventListener('click', async () => {
      await fetch('/api/admin/auth/logout', { method: 'POST' });
      location.reload();
    });

    // ── Markets list ───────────────────────────────────────────────────────────
    let cachedMarkets = [];
    let cachedStats = {};
    let activeTab = 'open'; // 'open' | 'resolved' | 'hidden'

    function filterByTab(markets, tab) {
      if (tab === 'hidden') return markets.filter(m => m.hidden);
      if (tab === 'resolved') return markets.filter(m => !m.hidden && m.status === 'resolved');
      if (tab === 'refunded') return markets.filter(m => !m.hidden && m.status === 'refunded');
      return markets.filter(m => !m.hidden && m.status === 'open');
    }

    function updateSidebarCounts() {
      const opts = { open: 0, resolved: 0, refunded: 0, hidden: 0 };
      for (const m of cachedMarkets) {
        if (m.hidden) opts.hidden++;
        else if (m.status === 'resolved') opts.resolved++;
        else if (m.status === 'refunded') opts.refunded++;
        else opts.open++;
      }
      document.querySelectorAll('.tab-count').forEach(el => {
        const n = opts[el.dataset.count] ?? 0;
        el.textContent = n > 0 ? `(${n})` : '';
      });
    }

    function updateSectionTitle() {
      const titles = { open: 'Open Markets', resolved: 'Resolved Markets', refunded: 'Refunded Markets', hidden: 'Hidden Markets' };
      document.getElementById('section-title').textContent = titles[activeTab];
    }

    function renderActiveTab() {
      const list = document.getElementById('markets-list');
      const items = filterByTab(cachedMarkets, activeTab);
      // Hidden tab mixes statuses — pick renderer per row. Refunded uses the
      // resolved-style read-only card (no action buttons).
      const renderOne = (m) => {
        if (activeTab === 'resolved') return renderResolved(m);
        if (activeTab === 'refunded') return renderRefunded(m);
        if (activeTab === 'hidden') {
          if (m.status === 'resolved') return renderResolved(m);
          if (m.status === 'refunded') return renderRefunded(m);
        }
        return renderOpen(m);
      };
      list.innerHTML = items.length
        ? items.map(renderOne).join('')
        : `<div class="text-sm text-gray-500 italic">No ${activeTab} markets.</div>`;

      document.querySelectorAll('.resolve-yes').forEach(btn => btn.addEventListener('click', () => resolveMarket(btn.dataset.id, 'Yes', btn)));
      document.querySelectorAll('.resolve-no').forEach(btn => btn.addEventListener('click', () => resolveMarket(btn.dataset.id, 'No', btn)));
      document.querySelectorAll('.force-refund-btn').forEach(btn => btn.addEventListener('click', () => forceRefundMarket(btn.dataset.id, btn)));
      document.querySelectorAll('.edit-btn').forEach(btn => btn.addEventListener('click', () => openEditModal(btn.dataset.id)));
      document.querySelectorAll('.delete-btn').forEach(btn => btn.addEventListener('click', () => deleteMarket(btn.dataset.id)));
      document.querySelectorAll('.publish-btn').forEach(btn => btn.addEventListener('click', () => togglePublish(btn.dataset.id, true)));
      document.querySelectorAll('.unpublish-btn').forEach(btn => btn.addEventListener('click', () => togglePublish(btn.dataset.id, false)));
      document.querySelectorAll('.hide-btn').forEach(btn => btn.addEventListener('click', () => toggleHide(btn.dataset.id, true)));
      document.querySelectorAll('.unhide-btn').forEach(btn => btn.addEventListener('click', () => toggleHide(btn.dataset.id, false)));
    }

    async function loadMarkets() {
      const [mResp, sResp] = await Promise.all([
        fetch('/api/admin/markets'),
        fetch('/api/admin/stats'),
      ]);
      if (mResp.status === 401) {
        showToast('Session expired', 'Please log in again.', 'error');
        location.reload();
        return;
      }
      const list = document.getElementById('markets-list');
      if (!mResp.ok) {
        const txt = await mResp.text().catch(() => '');
        list.innerHTML = `<div class="text-sm text-red-400">Failed to load markets (HTTP ${mResp.status}). ${txt.slice(0, 200)}</div>`;
        return;
      }
      const parsed = await mResp.json();
      if (!Array.isArray(parsed)) {
        list.innerHTML = `<div class="text-sm text-red-400">Unexpected response: ${JSON.stringify(parsed).slice(0, 200)}</div>`;
        return;
      }
      cachedMarkets = parsed;
      cachedStats = sResp.ok ? await sResp.json() : {};
      updateSidebarCounts();
      renderActiveTab();
      // Fire-and-forget: any market with a pendingResolveTxHash still in
      // `open` state means a resolve tx was submitted but mark-resolved
      // hasn't landed yet (3-conf gate). Retry silently in the background.
      retryPendingResolves();
      // Same idea for force-refund: mark-refunded can 400 if Koios still
      // shows the bet UTxOs after the force-refund tx lands. The flag is
      // persisted server-side so we retry on every admin page load.
      retryPendingRefunded();
    }

    let retryingRefunded = false;
    async function retryPendingRefunded() {
      if (retryingRefunded) return;
      const pending = cachedMarkets.filter(m => m.status === 'open' && m.pendingRefunded);
      if (!pending.length) return;
      retryingRefunded = true;
      let anyFlipped = false;
      try {
        for (const m of pending) {
          try {
            const r = await fetch(`/api/admin/markets/${encodeURIComponent(m.id)}/mark-refunded`, { method: 'POST' });
            if (r.ok) {
              anyFlipped = true;
            } else {
              // 400 = Koios still showing bet UTxOs; retry next load.
              const e = await r.json().catch(() => ({}));
              console.info(`[pending-refunded] ${m.id}: ${e.error ?? r.status}`);
            }
          } catch (e) {
            console.warn(`[pending-refunded] ${m.id} errored:`, e);
          }
        }
      } finally {
        retryingRefunded = false;
      }
      if (anyFlipped) await loadMarkets();
    }

    let retryingPending = false;
    async function retryPendingResolves() {
      if (retryingPending) return;
      const pending = cachedMarkets.filter(m => m.status === 'open' && m.pendingResolveTxHash);
      if (!pending.length) return;
      retryingPending = true;
      let anyFlipped = false;
      try {
        for (const m of pending) {
          try {
            const r = await fetch(`/api/admin/markets/${encodeURIComponent(m.id)}/mark-resolved`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ txHash: m.pendingResolveTxHash }),
            });
            if (r.ok) {
              anyFlipped = true;
            } else {
              // 400 = not enough confirmations yet, totally normal. Keep quiet.
              const e = await r.json().catch(() => ({}));
              console.info(`[pending-resolve] ${m.id}: ${e.error ?? r.status}`);
            }
          } catch (e) {
            console.warn(`[pending-resolve] ${m.id} errored:`, e);
          }
        }
      } finally {
        retryingPending = false;
      }
      if (anyFlipped) {
        // Refresh the list so the newly-resolved rows move into the Resolved tab.
        await loadMarkets();
      }
    }

    // Sidebar tab clicks
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeTab = btn.dataset.tab;
        updateSectionTitle();
        renderActiveTab();
      });
    });

    async function toggleHide(id, hide) {
      try {
        const r = await fetch(`/api/admin/markets/${encodeURIComponent(id)}/${hide ? 'hide' : 'unhide'}`, { method: 'POST' });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          if (r.status === 401) { showToast('Session expired', 'Log in again.', 'error'); setTimeout(() => location.reload(), 1500); return; }
          throw new Error(err.error ?? `HTTP ${r.status}`);
        }
        await loadMarkets();
      } catch (err) {
        showToast((hide ? 'Hide' : 'Unhide') + ' failed', err.message, 'error');
      }
    }

    async function togglePublish(id, publish) {
      try {
        const r = await fetch(`/api/admin/markets/${encodeURIComponent(id)}/${publish ? 'publish' : 'unpublish'}`, { method: 'POST' });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          if (r.status === 401) { showToast('Session expired', 'Log in again.', 'error'); setTimeout(() => location.reload(), 1500); return; }
          throw new Error(err.error ?? `HTTP ${r.status}`);
        }
        await loadMarkets();
      } catch (err) {
        showToast((publish ? 'Publish' : 'Unpublish') + ' failed', err.message, 'error');
      }
    }

    function renderOpen(m) {
      const endsDate = new Date(m.deadline).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
      const stats = cachedStats[m.id];
      const betCount = stats?.betCount ?? 0;
      const totalEct = stats ? (stats.totalEct / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '0';
      const canDelete = betCount === 0;
      return `
        <div class="bg-[#0f1623] border ${m.published ? 'border-[#1e2d45]' : 'border-yellow-900/60 border-dashed'} rounded-xl p-4">
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                ${m.published
                  ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-green-900/50 text-green-400 border border-green-800 uppercase tracking-wider font-semibold">Live</span>`
                  : `<span class="text-[10px] px-1.5 py-0.5 rounded bg-yellow-900/50 text-yellow-400 border border-yellow-800 uppercase tracking-wider font-semibold">Draft</span>`}
                <div class="font-semibold">${escapeHtml(m.title)}</div>
              </div>
              <div class="text-xs text-gray-500 mt-1">
                ${escapeHtml(m.category)} · YES ${m.yesPrice}% / NO ${m.noPrice}% · Ends ${endsDate}
              </div>
              <div class="text-xs mt-1">
                <span class="text-blue-400">${betCount}</span>
                <span class="text-gray-500"> bet${betCount === 1 ? '' : 's'} · </span>
                <span class="text-green-400">${totalEct}</span>
                <span class="text-gray-500"> ECT in pot</span>
              </div>
            </div>
            <div class="flex gap-2 flex-shrink-0 flex-wrap justify-end">
              ${m.published
                ? `<button class="unpublish-btn text-xs px-2.5 py-1.5 rounded-lg ${canDelete ? 'bg-yellow-800 hover:bg-yellow-700' : 'bg-gray-800 opacity-40 cursor-not-allowed'} font-semibold" data-id="${m.id}" ${canDelete ? '' : 'disabled'} title="${canDelete ? 'Hide from main page' : 'Cannot unpublish — has bets on-chain'}">Unpublish</button>`
                : `<button class="publish-btn text-xs px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 font-semibold" data-id="${m.id}">Publish</button>`}
              <button class="edit-btn text-xs px-2.5 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 font-semibold" data-id="${m.id}">Edit</button>
              ${m.hidden
                ? `<button class="unhide-btn text-xs px-2.5 py-1.5 rounded-lg bg-indigo-800 hover:bg-indigo-700 font-semibold" data-id="${m.id}" title="Show in Open/Resolved tabs">Unhide</button>`
                : `<button class="hide-btn text-xs px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 font-semibold" data-id="${m.id}" title="Move to Hidden tab (does not affect bets on-chain)">Hide</button>`}
              <button class="delete-btn text-xs px-2.5 py-1.5 rounded-lg ${canDelete ? 'bg-red-900 hover:bg-red-800' : 'bg-gray-800 opacity-40 cursor-not-allowed'} font-semibold" data-id="${m.id}" ${canDelete ? '' : 'disabled'} title="${canDelete ? 'Delete market' : 'Cannot delete — has bets on-chain'}">✕</button>
              <button class="resolve-yes text-xs px-3 py-1.5 rounded-lg bg-green-700 hover:bg-green-600 font-semibold" data-id="${m.id}">Resolve YES</button>
              <button class="resolve-no text-xs px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 font-semibold" data-id="${m.id}">Resolve NO</button>
              ${betCount > 0 ? `<button class="force-refund-btn text-xs px-3 py-1.5 rounded-lg bg-orange-800 hover:bg-orange-700 font-semibold" data-id="${m.id}" title="Oracle-signed mass refund — returns all ${betCount} bet${betCount === 1 ? '' : 's'} to their original wallets. Use for cancelled markets or winner-pool-zero cases.">Refund all</button>` : ''}
            </div>
          </div>
        </div>
      `;
    }

    async function deleteMarket(id) {
      const m = cachedMarkets.find(x => x.id === id);
      if (!m) return;
      if (!await showConfirm('Delete market?', `"${m.title}"\n\nThis is permanent.`, 'danger')) return;
      try {
        const r = await fetch(`/api/admin/markets/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          if (r.status === 401) { showToast('Session expired', 'Log in again.', 'error'); setTimeout(() => location.reload(), 1500); return; }
          throw new Error(err.error ?? `HTTP ${r.status}`);
        }
        await loadMarkets();
      } catch (err) {
        showToast('Delete failed', err.message, 'error');
      }
    }

    function renderResolved(m) {
      const txHash = m.resolutionUtxoRef ? m.resolutionUtxoRef.split('#')[0] : '';
      return `
        <div class="bg-[#0f1623] border border-gray-700 rounded-xl p-4 opacity-80">
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1 min-w-0">
              <div class="font-semibold">${escapeHtml(m.title)}</div>
              <div class="text-xs text-gray-500 mt-1">
                ${escapeHtml(m.category)} · Resolved
                ${/^[0-9a-fA-F]{64}$/.test(txHash || '') ? ` · <a target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:underline" href="https://cexplorer.io/tx/${txHash}">tx</a>` : ''}
              </div>
            </div>
            <div class="flex gap-2 flex-shrink-0">
              ${m.hidden
                ? `<button class="unhide-btn text-xs px-2.5 py-1.5 rounded-lg bg-indigo-800 hover:bg-indigo-700 font-semibold" data-id="${m.id}">Unhide</button>`
                : `<button class="hide-btn text-xs px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 font-semibold" data-id="${m.id}">Hide</button>`}
            </div>
          </div>
        </div>
      `;
    }

    function renderRefunded(m) {
      return `
        <div class="bg-[#0f1623] border border-orange-900/60 rounded-xl p-4 opacity-80">
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-orange-900/50 text-orange-400 border border-orange-800 uppercase tracking-wider font-semibold">Refunded</span>
                <div class="font-semibold">${escapeHtml(m.title)}</div>
              </div>
              <div class="text-xs text-gray-500 mt-1">
                ${escapeHtml(m.category)} · All bets returned to bettors
              </div>
            </div>
            <div class="flex gap-2 flex-shrink-0">
              ${m.hidden
                ? `<button class="unhide-btn text-xs px-2.5 py-1.5 rounded-lg bg-indigo-800 hover:bg-indigo-700 font-semibold" data-id="${m.id}">Unhide</button>`
                : `<button class="hide-btn text-xs px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 font-semibold" data-id="${m.id}">Hide</button>`}
            </div>
          </div>
        </div>
      `;
    }

    // ── Resolve tx flow ────────────────────────────────────────────────────────
    async function resolveMarket(marketId, winner, btn) {
      const market = (await (await fetch('/api/markets')).json()).find(m => m.id === marketId);
      if (!await showConfirm(`Resolve as ${winner === 'Yes' ? 'YES' : 'NO'}?`, `"${market.title}"`)) return;
      // Disable the resolve pair so a double-click can't kick off two
      // server-side tx builds + wallet prompts against the same market.
      const row = btn?.closest('[data-market-row]') ?? btn?.parentElement;
      const rowBtns = row ? Array.from(row.querySelectorAll('button')) : (btn ? [btn] : []);
      const prevState = rowBtns.map(b => [b, b.disabled]);
      rowBtns.forEach(b => { b.disabled = true; });
      const origText = btn ? btn.textContent : null;
      if (btn) btn.textContent = '…';
      const unlock = () => {
        prevState.forEach(([b, d]) => { b.disabled = d; });
        if (btn && origText !== null) btn.textContent = origText;
      };
      try {
        // If we auto-logged-in via session cookie, walletApi is still null.
        // Trigger a silent reconnect via the first available wallet.
        if (!W.state.walletApi) {
          const wallets = W.getAvailableWallets();
          if (!wallets.length) throw new Error('No Cardano wallet detected in browser');
          // Prefer Lace if available, else first one.
          const preferred = wallets.find(w => w.toLowerCase() === 'lace') ?? wallets[0];
          await W.connectWallet(preferred);
        }
        const api = W.state.walletApi;
        if (!api) throw new Error('Wallet not connected');
        // Server ignores any client-supplied oracle address / walletUtxos —
        // it always uses the hardcoded ORACLE_ADDRESS and fetches UTxOs from
        // Koios. We still need the wallet for signing.
        const resp = await fetch('/api/tx/resolve-market', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ marketId, winner }),
        });
        if (!resp.ok) {
          const e = await resp.json();
          if (resp.status === 401) { showToast('Session expired', 'Log in again.', 'error'); setTimeout(() => location.reload(), 1500); return; }
          throw new Error(e.error ?? 'Server error');
        }
        const { unsignedTx, summary } = await resp.json();

        // Require summary — never sign a server-built resolution tx blind.
        // The summary lets the oracle cross-check totals/winners before
        // committing to a signature.
        if (!summary) {
          throw new Error('Server did not return a resolution summary; refusing to sign blind.');
        }
        {
          const confirmMsg = [
            `This resolution tx will:`,
            `• Consume ${summary.totalBets} bet UTxOs (${summary.winners} winners, ${summary.losers} losers)`,
            `• Pool totals: YES=${(summary.totalYes/1e6).toLocaleString()} ECT, NO=${(summary.totalNo/1e6).toLocaleString()} ECT`,
            `• Distribute ${(summary.distributionPool/1e6).toLocaleString()} ECT to winners`,
            `• Send ${(summary.fee/1e6).toLocaleString()} ECT (3%) to treasury`,
            ``,
            `Sign and submit?`,
          ].join('\n');
          if (!await showConfirm('Confirm resolution tx', confirmMsg)) return;
        }

        const signed = await api.signTx(unsignedTx, true);
        const finalTx = await W.assembleSignedTx(unsignedTx, signed);
        const txHash = await api.submitTx(finalTx);

        // Persist txHash server-side IMMEDIATELY so auto-retry on next page
        // load can finish the mark-resolved step once the 3-conf gate clears,
        // even if the admin closes the browser right now.
        try {
          await fetch(`/api/admin/markets/${encodeURIComponent(marketId)}/pending-resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              txHash,
              summary: {
                winnerSide: winner,
                totalYes: summary.totalYes,
                totalNo: summary.totalNo,
                distributionPool: summary.distributionPool,
                fee: summary.fee,
              },
            }),
          });
        } catch (e) {
          console.warn('pending-resolve save failed:', e);
        }

        // Try mark-resolved now — usually this 400s for a while (waiting for
        // 3 confirmations). That's fine: retryPendingResolves() on every
        // subsequent loadMarkets() will keep trying until it succeeds.
        try {
          const r = await fetch(`/api/admin/markets/${encodeURIComponent(marketId)}/mark-resolved`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txHash }),
          });
          if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            console.info('mark-resolved deferred:', e.error ?? `HTTP ${r.status}`);
          }
        } catch (e) {
          console.warn('mark-resolved failed (tx still submitted):', e);
        }

        showToast('Market resolved', 'Status will flip to "resolved" after 3 confirmations (~2 min). Reload the page if it lingers.', 'success', { txHash });
        await loadMarkets();
      } catch (err) {
        console.error('Resolve error:', err);
        const msg = String(err?.message ?? err).split('\n')[0].slice(0, 200);
        showToast('Resolve failed', msg, 'error');
      } finally {
        unlock();
      }
    }

    // ── Force-refund (oracle mass refund) ──────────────────────────────────────
    async function forceRefundMarket(marketId, btn) {
      const market = cachedMarkets.find(m => m.id === marketId);
      if (!market) return;
      const stats = cachedStats[marketId];
      const betCount = stats?.betCount ?? 0;
      const totalEct = stats ? (stats.totalEct / 1_000_000).toLocaleString() : '?';
      const confirmMsg = [
        `"${market.title}"`,
        ``,
        `This will refund ALL ${betCount} bet${betCount === 1 ? '' : 's'} (~${totalEct} ECT total) to their original wallets.`,
        ``,
        `The market will NOT be marked resolved — bettors get their stake back, the house earns no fee.`,
        ``,
        `Use for: cancelled events, winner-pool-zero, oracle-mistake rollbacks.`,
        ``,
        `Continue?`,
      ].join('\n');
      if (!await showConfirm('Refund everyone?', confirmMsg, 'danger')) return;

      const origText = btn ? btn.textContent : null;
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      try {
        if (!W.state.walletApi) {
          const wallets = W.getAvailableWallets();
          if (!wallets.length) throw new Error('No Cardano wallet detected');
          const preferred = wallets.find(w => w.toLowerCase() === 'lace') ?? wallets[0];
          await W.connectWallet(preferred);
        }
        const api = W.state.walletApi;
        if (!api) throw new Error('Wallet not connected');

        let batch = 0;
        let lastTxHash = null;
        // Loop: server always slices the first N bet UTxOs from a fresh Koios
        // fetch, so each iteration picks up whatever's still at the contract
        // (confirmed spends drop out naturally). Stops when remaining === 0.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          batch++;
          if (btn) btn.textContent = `batch ${batch}…`;
          const resp = await fetch('/api/tx/admin/force-refund', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ marketId, limit: 40 }),
          });
          if (!resp.ok) {
            const e = await resp.json().catch(() => ({}));
            if (resp.status === 401) { showToast('Session expired', 'Log in again.', 'error'); setTimeout(() => location.reload(), 1500); return; }
            // 400 "No bet UTxOs" on batch > 1 means we're done — all already refunded.
            if (batch > 1 && resp.status === 400) break;
            throw new Error(e.error ?? `HTTP ${resp.status}`);
          }
          const { unsignedTx, batchSize, remaining, totalBets } = await resp.json();
          const signed = await api.signTx(unsignedTx, true);
          const finalTx = await W.assembleSignedTx(unsignedTx, signed);
          lastTxHash = await api.submitTx(finalTx);
          console.info(`[force-refund] batch ${batch}: ${batchSize}/${totalBets} bets refunded (tx ${lastTxHash}), ${remaining} remaining`);
          if (remaining === 0) break;
          // Wait for this batch to confirm before starting the next — otherwise
          // the next tx would try to spend the same UTxOs that are still in
          // mempool. Poll /api/admin/tx-status until we see ≥1 confirmation,
          // then proceed. Safety ceiling: give up after 6 min and fall back to
          // a short fixed wait so a stuck status request doesn't hang the loop.
          showToast('Batch submitted', `Waiting for tx confirmation before next batch (${remaining} bets remaining)…`, 'info');
          const deadline = Date.now() + 6 * 60_000;
          let confirmed = false;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 10_000));
            try {
              const sr = await fetch(`/api/admin/tx-status/${encodeURIComponent(lastTxHash)}`);
              if (sr.ok) {
                const { confirmations } = await sr.json();
                if (btn) btn.textContent = `batch ${batch} conf ${confirmations}…`;
                if (confirmations >= 1) { confirmed = true; break; }
              }
            } catch (e) {
              console.warn('tx-status poll failed:', e);
            }
          }
          if (!confirmed) {
            console.warn('[force-refund] tx-status poll timed out; pausing 30s as fallback');
            await new Promise(r => setTimeout(r, 30_000));
          }
        }

        // Persist the "pending refunded" flag IMMEDIATELY so auto-retry on
        // the next admin page load can finish the status flip even if the
        // browser closes now. Also stash the pre-refund bet count + ECT total
        // so the Discord announce on mark-refunded can show accurate numbers
        // (by then, bets are gone from contract and can't be counted).
        try {
          await fetch(`/api/admin/markets/${encodeURIComponent(marketId)}/pending-refunded`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              betCount: stats?.betCount ?? 0,
              totalEct: stats?.totalEct ?? 0,
            }),
          });
        } catch (e) {
          console.warn('pending-refunded save failed:', e);
        }

        // Flip market status to "refunded". Server verifies no bet UTxOs remain
        // at contract before accepting — if Koios lags and still sees one, this
        // will 400 and the market stays "open" until retryPendingRefunded()
        // on a later loadMarkets() succeeds.
        try {
          const r = await fetch(`/api/admin/markets/${encodeURIComponent(marketId)}/mark-refunded`, { method: 'POST' });
          if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            console.info('mark-refunded deferred:', e.error ?? `HTTP ${r.status}`);
          }
        } catch (e) {
          console.warn('mark-refunded failed (bets still returned on-chain):', e);
        }

        showToast('Mass refund submitted', 'All bets returned to their original wallets.', 'success', { txHash: lastTxHash });
        await loadMarkets();
      } catch (err) {
        console.error('Force-refund error:', err);
        const msg = String(err?.message ?? err).split('\n')[0].slice(0, 200);
        showToast('Refund failed', msg, 'error');
      } finally {
        if (btn) { btn.disabled = false; if (origText !== null) btn.textContent = origText; }
      }
    }

    // ── New / edit market modal ────────────────────────────────────────────────
    const nmModal = document.getElementById('new-market-modal');
    const nmForm = document.getElementById('new-market-form');
    const nmError = document.getElementById('nm-error');
    const nmSubmit = document.getElementById('nm-submit');
    let editingId = null; // null = creating, otherwise the market id we're editing

    function openEditModal(id) {
      const m = cachedMarkets.find(x => x.id === id);
      if (!m) return;
      editingId = id;
      nmForm.reset();
      nmError.textContent = '';
      nmForm.id.value = m.id;
      nmForm.id.readOnly = true;
      nmForm.id.classList.add('opacity-60');
      nmForm.title.value = m.title;
      nmForm.category.value = m.category;
      nmForm.yesPrice.value = m.yesPrice;
      nmForm.noPrice.value = m.noPrice;
      // datetime-local expects YYYY-MM-DDTHH:MM in *local* time, not UTC.
      const md = new Date(m.deadline);
      const pad = n => String(n).padStart(2, '0');
      nmForm.deadline.value =
        `${md.getFullYear()}-${pad(md.getMonth()+1)}-${pad(md.getDate())}T${pad(md.getHours())}:${pad(md.getMinutes())}`;
      document.querySelector('#new-market-modal h2').textContent = 'Edit Market';
      nmSubmit.textContent = 'Save';
      nmModal.classList.remove('hidden');
    }

    document.getElementById('new-market-btn').addEventListener('click', () => {
      editingId = null;
      nmForm.reset();
      nmError.textContent = '';
      nmForm.id.readOnly = false;
      nmForm.id.classList.remove('opacity-60');
      document.querySelector('#new-market-modal h2').textContent = 'Create Market';
      nmSubmit.textContent = 'Create';
      // Default deadline = now (admin edits up from here)
      const d = new Date();
      const pad = n => String(n).padStart(2, '0');
      nmForm.deadline.value =
        `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      nmForm.yesPrice.value = 50;
      nmForm.noPrice.value = 50;
      nmModal.classList.remove('hidden');
    });
    document.getElementById('nm-close').addEventListener('click', () => nmModal.classList.add('hidden'));
    nmModal.addEventListener('click', e => { if (e.target === nmModal) nmModal.classList.add('hidden'); });

    // Auto-complement YES/NO prices so they always sum to 100
    nmForm.yesPrice.addEventListener('input', () => {
      const y = parseInt(nmForm.yesPrice.value, 10);
      if (Number.isFinite(y) && y >= 1 && y <= 99) nmForm.noPrice.value = 100 - y;
    });
    nmForm.noPrice.addEventListener('input', () => {
      const n = parseInt(nmForm.noPrice.value, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 99) nmForm.yesPrice.value = 100 - n;
    });

    nmForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      nmError.textContent = '';
      const isEdit = editingId !== null;
      nmSubmit.disabled = true;
      nmSubmit.textContent = isEdit ? 'Saving…' : 'Creating…';
      try {
        const fd = new FormData(nmForm);
        const deadlineMs = new Date(fd.get('deadline')).getTime();
        const body = {
          title: fd.get('title').trim(),
          category: fd.get('category'),
          yesPrice: parseInt(fd.get('yesPrice'), 10),
          noPrice: parseInt(fd.get('noPrice'), 10),
          deadline: deadlineMs,
        };
        let url, method;
        if (isEdit) {
          url = `/api/admin/markets/${encodeURIComponent(editingId)}`;
          method = 'PATCH';
        } else {
          url = '/api/admin/markets';
          method = 'POST';
          body.id = fd.get('id').trim();
        }
        const r = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          if (r.status === 401) { showToast('Session expired', 'Log in again.', 'error'); setTimeout(() => location.reload(), 1500); return; }
          throw new Error(err.error ?? `HTTP ${r.status}`);
        }
        nmModal.classList.add('hidden');
        await loadMarkets();
      } catch (err) {
        nmError.textContent = err.message;
      } finally {
        nmSubmit.disabled = false;
        nmSubmit.textContent = editingId !== null ? 'Save' : 'Create';
      }
    });

    checkSession();
