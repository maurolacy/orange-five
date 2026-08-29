(function() {
  'use strict';

  const currentHost = window.location.hostname;
  if (!currentHost.includes('wnttv') && !currentHost.includes('youtube') && !currentHost.includes('matchroom')) {
    return;
  }

  const FILTER = 'hue-rotate(25deg) saturate(1.5)';

  function findVideosInShadow(root) {
    const videos = [];
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'VIDEO') videos.push(el);
      if (el.shadowRoot) videos.push(...findVideosInShadow(el.shadowRoot));
    }
    return videos;
  }

  function applyFilter() {
    // Apply directly to video elements inside Shadow DOM (CSS filters on
    // outer containers don't reach hardware-accelerated video overlays).
    document.querySelectorAll('mux-player, mux-video').forEach(host => {
      if (!host.shadowRoot) return;
      findVideosInShadow(host.shadowRoot).forEach(v => {
        if (v.dataset.orangePatched) return;
        v.style.setProperty('filter', FILTER, 'important');
        v.dataset.orangePatched = '1';
        console.log('Color Engine Hooked: Purple 5-ball eradicated.');
      });
    });

    // Fallback: also target any light-DOM video elements directly
    document.querySelectorAll('video').forEach(v => {
      if (v.dataset.orangePatched) return;
      v.style.setProperty('filter', FILTER, 'important');
      v.dataset.orangePatched = '1';
      console.log('Color Engine Hooked: Purple 5-ball eradicated.');
    });
  }

  const observer = new MutationObserver(() => applyFilter());

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    applyFilter();
  }
})();
