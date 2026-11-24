/* 休闲一下：搜索、卡片选游戏、原地在右侧内容区启动 Ruffle */
(function () {
  var page = document.getElementById('games-page');
  if (!page) return;

  var root = page.getAttribute('data-root') || '/games/';
  var toolbar = document.getElementById('games-toolbar');
  var grid = document.getElementById('games-grid');
  var cards = Array.prototype.slice.call(grid.querySelectorAll('.games-card'));
  var search = document.getElementById('games-search');
  var total = document.getElementById('games-total');
  var empty = document.getElementById('games-empty');
  var playerBox = document.getElementById('games-player');
  var stageBox = document.getElementById('games-stage-box');
  var stage = document.getElementById('games-stage');
  var status = document.getElementById('games-status');
  var statusText = document.getElementById('games-status-text');
  var progress = document.getElementById('games-progress');
  var progressFill = document.getElementById('games-progress-fill');
  var progressNum = document.getElementById('games-progress-num');
  var nameEl = document.getElementById('games-player-name');

  function setTotal(n) {
    if (total) total.textContent = '共 ' + n + ' 款';
  }
  setTotal(cards.length);

  // 搜索
  search.addEventListener('input', function () {
    var q = search.value.trim().toLowerCase();
    var shown = 0;
    cards.forEach(function (card) {
      var hit = (card.getAttribute('data-title') || '').toLowerCase().indexOf(q) !== -1;
      card.hidden = !hit;
      if (hit) shown++;
    });
    setTotal(q ? shown : cards.length);
    empty.hidden = shown !== 0;
  });

  var ruffleReady = null;
  var activeCard = null;
  var currentPlayer = null;
  var abortCtrl = null;
  var seq = 0; // 每次启动/停止自增，用来丢弃已过期任务的回调

  function readable(n) {
    if (!isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function setStatus(text) {
    statusText.textContent = text || '';
    status.hidden = !text;
  }

  // pct 为 null 时显示「不确定进度」的流动条
  function setProgress(pct, label) {
    progress.hidden = false;
    if (pct === null) {
      progress.classList.add('is-indeterminate');
      progressFill.style.width = '';
      progressNum.textContent = label || '';
    } else {
      progress.classList.remove('is-indeterminate');
      progressFill.style.width = pct + '%';
      progressNum.textContent = label || (pct + '%');
    }
  }

  function hideProgress() {
    progress.hidden = true;
    progress.classList.remove('is-indeterminate');
    progressFill.style.width = '0%';
    progressNum.textContent = '';
  }

  function loadRuffle() {
    if (ruffleReady) return ruffleReady;
    ruffleReady = new Promise(function (resolve, reject) {
      var sources = [
        { src: root + 'ruffle/ruffle.js', pub: root + 'ruffle/' },
        { src: 'https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.8.0/ruffle.js', pub: 'https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.8.0/' },
        { src: 'https://unpkg.com/@ruffle-rs/ruffle@0.8.0/ruffle.js', pub: 'https://unpkg.com/@ruffle-rs/ruffle@0.8.0/' }
      ];
      function attempt(i) {
        if (i >= sources.length) { reject(new Error('Ruffle 加载失败')); return; }
        var s = sources[i];
        window.RufflePlayer = window.RufflePlayer || {};
        window.RufflePlayer.config = {
          publicPath: s.pub,
          polyfills: false,
          autoplay: 'on',
          splashScreen: false,
          unmuteOverlay: 'hidden',
          letterbox: 'on',
          backgroundColor: '#000000',
          warnOnUnsupportedContent: false,
          showSwfDownload: false,
          allowScriptAccess: true,
          // 禁止 SWF 自己请求全屏（部分游戏一启动就 stage.displayState=fullScreen）。
          // 页面上的「全屏」按钮走浏览器原生 requestFullscreen，与此配置无关。
          allowFullscreen: false,
          quality: 'high',
          scale: 'showAll',
          // 部分游戏（如死神3.01）选人时要解析大量数据，在 Ruffle 下较慢，
          // 默认 15s 会被强制中断。Ruffle 0.8 要求直接写秒数（旧对象格式已废弃）。
          maxExecutionDuration: 300,
          // 统一中文字库：部分 SWF 未内嵌字体，靠系统回退会在不同机器上显示异常。
          // font.swf 是 SimSun 精简字库（约 1MB），和 oldswf 的 defaultFonts 配置一致。
          fontSources: [root + 'ruffle/font.swf'],
          defaultFonts: { sans: ['SimSun'], serif: ['SimSun'], typewriter: ['SimSun'] }
        };
        var el = document.createElement('script');
        el.src = s.src;
        el.async = true;
        el.onload = function () { setTimeout(resolve, 30); };
        el.onerror = function () { attempt(i + 1); };
        document.head.appendChild(el);
      }
      attempt(0);
    });
    return ruffleReady;
  }

  function stopPlayer() {
    seq++;
    if (abortCtrl) {
      try { abortCtrl.abort(); } catch (e) {}
      abortCtrl = null;
    }
    if (currentPlayer) {
      try { currentPlayer.remove(); } catch (e) {}
      currentPlayer = null;
    }
    stage.innerHTML = '';
  }

  function concatChunks(chunks) {
    var len = 0, i, out, off = 0;
    for (i = 0; i < chunks.length; i++) len += chunks[i].length;
    out = new Uint8Array(len);
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
    return out;
  }

  // 分块读取 SWF，实时汇报字节进度；读完以 data 模式交给 Ruffle。
  // 不用 blob URL：Ruffle 的 SharedObject 存档 key 绑定 SWF 的 URL，
  // blob: 地址带随机 uuid，每次打开 key 都变，游戏进度就存不住。
  function fetchSwf(url, mySeq) {
    var ctrl = new AbortController();
    abortCtrl = ctrl;
    return fetch(url, { signal: ctrl.signal }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var totalBytes = parseInt(res.headers.get('content-length'), 10) || 0;
      if (!res.body || !res.body.getReader) {
        return res.arrayBuffer().then(function (buf) {
          if (mySeq !== seq) return null;
          setProgress(100, '100%  ·  ' + readable(buf.byteLength));
          return new Uint8Array(buf);
        });
      }
      var reader = res.body.getReader();
      var chunks = [], received = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (mySeq !== seq) return null;
          if (r.done) {
            setProgress(100, totalBytes ? '100%  ·  ' + readable(received) : readable(received));
            return concatChunks(chunks);
          }
          chunks.push(r.value);
          received += r.value.length;
          if (totalBytes) {
            var pct = Math.min(99, Math.floor(received / totalBytes * 100));
            setProgress(pct, pct + '%  ·  ' + readable(received) + ' / ' + readable(totalBytes));
          } else {
            setProgress(null, readable(received));
          }
          return pump();
        });
      }
      return pump();
    }).finally(function () {
      if (abortCtrl === ctrl) abortCtrl = null;
    });
  }

  function play(card) {
    activeCard = card;
    var w = parseInt(card.getAttribute('data-w'), 10) || 800;
    var h = parseInt(card.getAttribute('data-h'), 10) || 600;
    var file = card.getAttribute('data-file');
    var url = root + 'swf/' + file;

    nameEl.textContent = card.getAttribute('data-title') || '';
    stageBox.style.setProperty('--g-ratio', (w / h).toFixed(4));
    toolbar.hidden = true;
    grid.hidden = true;
    empty.hidden = true;
    playerBox.hidden = false;
    stopPlayer();
    var mySeq = seq;
    setStatus('正在启动 Flash 播放器…');
    setProgress(null, '');

    loadRuffle().then(function () {
      if (mySeq !== seq) return null;
      setStatus('正在加载游戏…');
      setProgress(0, '0%');
      return fetchSwf(url, mySeq);
    }).then(function (bytes) {
      if (mySeq !== seq || !bytes) return null;
      setStatus('正在初始化游戏…');
      setProgress(null, '');
      var rp = window.RufflePlayer;
      var source = rp && rp.newest ? rp.newest() : null;
      if (!source) throw new Error('Ruffle 未就绪');
      var player = source.createPlayer();
      player.style.width = '100%';
      player.style.height = '100%';
      stage.appendChild(player);
      currentPlayer = player;
      // data 模式下 movie URL = 当前页面目录 + swfFileName，是固定地址，
      // SharedObject 才会落在稳定的 localStorage key 上，进度能跨次保留。
      if (typeof player.load === 'function') {
        return player.load({ data: bytes, swfFileName: file });
      }
      throw new Error('播放器不支持 load()');
    }).then(function () {
      if (mySeq !== seq) return;
      setStatus('');
      hideProgress();
    }).catch(function (e) {
      if (mySeq !== seq) return;
      stopPlayer();
      setStatus('加载失败：' + (e && (e.message || e)));
      hideProgress();
    });
  }

  cards.forEach(function (card) {
    card.addEventListener('click', function () { play(card); });
  });

  // 支持 /games/#游戏编号 直接打开
  var hash = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (hash) {
    cards.forEach(function (card) {
      if (card.getAttribute('data-id') === hash) play(card);
    });
  }

  document.getElementById('games-back').addEventListener('click', function () {
    stopPlayer();
    playerBox.hidden = true;
    toolbar.hidden = false;
    grid.hidden = false;
    activeCard = null;
    setStatus('');
    hideProgress();
  });

  document.getElementById('games-reload').addEventListener('click', function () {
    if (activeCard) play(activeCard);
  });

  document.getElementById('games-full').addEventListener('click', function () {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
    } else if (stageBox.requestFullscreen) {
      stageBox.requestFullscreen();
    } else if (stageBox.webkitRequestFullscreen) {
      stageBox.webkitRequestFullscreen();
    }
  });
})();
