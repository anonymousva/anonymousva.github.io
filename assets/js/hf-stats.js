// HuggingFace 下载量统计（合并同一项目多个模型 + emotion2vec ModelScope 写死 + collection 自动展开）
(function() {
  var CACHE_KEY = 'hf_download_stats_v3';
  var CACHE_TTL = 1000 * 60 * 30;
  var MODELSCOPE_FIXED = 50000000;
  var THRESHOLD_ALL = 100000;
  var THRESHOLD_MONTH = 10000;

  // 语言检测
  var lang = (document.documentElement.lang || location.pathname.split('/')[1] || 'zh').toLowerCase();
  if (lang !== 'en') lang = 'zh';

  var i18n = {
    zh: {
      title: '📊 HuggingFace 下载量统计',
      total: '总下载量',
      monthly: '上月下载量',
      count: '统计项目数',
      cached: '统计中',
      loading: '正在统计...',
      totalLabel: '总下载',
      monthLabel: '月下载',
      detailMonthly: '月下载'
    },
    en: {
      title: '📊 HuggingFace Download Stats',
      total: 'Total Downloads',
      monthly: 'Monthly Downloads',
      count: 'Projects',
      cached: 'updating',
      loading: 'Loading...',
      totalLabel: 'Total',
      monthLabel: 'Monthly',
      detailMonthly: 'monthly'
    }
  }[lang];

  // 截断到两位有效数字（后面的全变0）
  function truncate2Digits(n) {
    if (!n || n <= 0) return 0;
    var digits = Math.floor(Math.log10(n)) + 1;
    var factor = Math.pow(10, digits - 2);
    return Math.floor(n / factor) * factor;
  }

  // 人性化数字（默认截断两位有效数字）
  function fmt(n, raw) {
    n = n || 0;
    if (!raw) n = truncate2Digits(n);
    if (lang === 'zh') {
      if (n >= 100000000) return Math.round(n / 1000000) / 100 + '亿';
      if (n >= 10000) return Math.round(n / 10000) + '万';
      return n.toLocaleString();
    } else {
      if (n >= 1000000000) {
        var v = n / 1000000000;
        return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')) + ' billion';
      }
      if (n >= 1000000) {
        var v = n / 1000000;
        return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')) + ' million';
      }
      if (n >= 1000) {
        return Math.round(n / 1000) + 'K';
      }
      return n.toLocaleString();
    }
  }

  // Tooltip CSS
  var style = document.createElement('style');
  style.textContent = '.hf-auto-download{position:relative;display:block;margin-top:0.4em;}.hf-info-wrap{position:relative;display:inline-block;vertical-align:middle;}.hf-info{font-style:normal;cursor:pointer;margin-left:4px;color:#888;font-size:0.85em;vertical-align:middle;}.hf-tooltip{display:none;position:absolute;bottom:100%;left:50%;transform:translateX(-50%);background:#fff;border:1px solid #ddd;border-radius:6px;padding:8px 12px;font-size:0.82em;color:#333;box-shadow:0 2px 8px rgba(0,0,0,0.1);z-index:100;white-space:normal;line-height:1.6;min-width:220px;margin-bottom:6px;text-align:left;}.hf-info-wrap:hover .hf-tooltip{display:block;}.hf-tooltip-row{display:flex;justify-content:space-between;gap:1em;margin:2px 0;}.hf-tooltip-label{color:#666;}.hf-tooltip-num{color:#111;font-weight:500;white-space:nowrap;}';
  document.head.appendChild(style);

  // 创建统计面板
  var panel = document.createElement('div');
  panel.id = 'hf-stats-panel';
  panel.style.cssText = 'margin:2em 0;padding:1.2em;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;';
  panel.innerHTML = '<h3 style="margin:0 0 0.8em 0;font-size:1.1em;">' + i18n.title + '</h3>'
    + '<div id="hf-stats-result"></div>'
    + '<div id="hf-stats-detail" style="display:none;margin-top:1em;font-size:0.85em;color:#666;"></div>';

  var customContainer = document.getElementById('download-stat-panel');
  if (customContainer) {
    customContainer.appendChild(panel);
  } else {
    var section = document.querySelector('.page__content');
    if (section) section.insertBefore(panel, section.firstChild);
  }

  // 标记 other-projects-section 之后的 blockquote 为跳过
  var otherSection = document.getElementById('other-projects-section');
  if (otherSection) {
    var el = otherSection.nextElementSibling;
    while (el) {
      if (el.tagName === 'H1') break;
      if (el.tagName === 'BLOCKQUOTE') el.classList.add('hf-skip-stats');
      el = el.nextElementSibling;
    }
  }

  // 自动为所有带 HF/ModelScope 链接的 blockquote 添加 hf-auto-download 占位符
  document.querySelectorAll('blockquote:not(.hf-skip-stats)').forEach(function(bq) {
    var hasRelevant = bq.querySelector('a[href*="huggingface.co"], a[href*="modelscope.cn"]');
    if (!hasRelevant) return;
    if (bq.querySelector('.hf-auto-download')) return;
    var lastP = bq.querySelector('p:last-of-type');
    if (lastP) {
      var span = document.createElement('span');
      span.className = 'hf-auto-download';
      lastP.appendChild(span);
    }
  });

  // 解析 HF repo
  function parseHFRepo(a) {
    var url = a.href;
    var m = url.match(/huggingface\.co\/(datasets\/)?([^\/]+)\/([^\/\?#]+)/);
    if (!m) return null;
    var type = m[1] ? 'datasets' : 'models';
    var author = m[2];
    var name = m[3];
    if (['collections','spaces','blog','docs','join','login','pricing','api'].indexOf(author) >= 0) return null;
    return { type: type, id: author + '/' + name };
  }

  // 解析 HF collection
  function parseCollection(a) {
    var url = a.href;
    var m = url.match(/huggingface\.co\/collections\/([^\/]+)\/([^\/\?#]+)/);
    if (!m) return null;
    return { owner: m[1], slug: m[2] };
  }

  // 收集所有 HF repo（包括 collection 中的模型）
  var links = Array.from(document.querySelectorAll('a[href*="huggingface.co"]'));
  var repoMap = {};
  var repoList = [];
  links.forEach(function(a) {
    var r = parseHFRepo(a);
    if (!r) return;
    var key = r.type + ':' + r.id;
    if (!repoMap[key]) {
      repoMap[key] = r;
      repoList.push(r);
    }
  });

  // 收集所有 collection 链接
  var collectionList = [];
  var collectionModelsMap = {}; // key: owner/slug -> [{type, id}]
  links.forEach(function(a) {
    var c = parseCollection(a);
    if (c) collectionList.push(c);
  });

  function updateIntro(totalAllTime) {
    var now = new Date();
    var year = now.getFullYear();
    var monthIdx = now.getMonth();
    var zhMonths = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
    var enMonths = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var pageLang = (document.documentElement.lang || 'zh').toLowerCase();
    if (pageLang !== 'en') pageLang = 'zh';
    document.querySelectorAll('.hf-intro-downloads').forEach(function(el) {
      if (pageLang === 'zh') {
        el.innerHTML = '截至目前（' + year + '年' + zhMonths[monthIdx] + '），我们团队主持开发的开源模型总下载量超<strong><span style="color:red">' + fmt(totalAllTime, true) + '次</span></strong>';
      } else {
        el.innerHTML = 'As of ' + enMonths[monthIdx] + ' ' + year + ', our open-source models have reached <strong><span style="color:red">' + fmt(totalAllTime, true) + '+ downloads</span></strong>';
      }
    });
  }

  var PROJECT_COUNT = document.querySelectorAll('.hf-auto-download').length;

  function renderSummary(totalAllTime, totalMonthly, count, isCached) {
    var badge = isCached ? '<span style="font-size:0.7em;color:#888;margin-left:0.5em;">(' + i18n.cached + ')</span>' : '';
    document.getElementById('hf-stats-result').innerHTML = '<div style="display:flex;gap:2em;flex-wrap:wrap;align-items:center;">'
      + '<div><span style="color:#64748b;font-size:0.85em;">' + i18n.total + '</span><br>'
      + '<span style="color:#1a1a1a;font-size:1.5em;font-weight:600;">' + fmt(totalAllTime, true) + '</span>' + badge + '</div>'
      + '<div><span style="color:#64748b;font-size:0.85em;">' + i18n.monthly + '</span><br>'
      + '<span style="color:#1a1a1a;font-size:1.5em;font-weight:600;">' + fmt(totalMonthly, true) + '</span></div>'
      + '<div><span style="color:#64748b;font-size:0.85em;">' + i18n.count + '</span><br>'
      + '<span style="color:#1a1a1a;font-size:1.5em;font-weight:600;">' + PROJECT_COUNT + '</span></div>'
      + '</div>';
  }

  // 填充占位符（替代原来的红字）
  function renderNotes(statsMap) {
    document.querySelectorAll('.hf-auto-download').forEach(function(el) {
      var bq = el.closest('blockquote');
      if (!bq) { el.style.display = 'none'; return; }
      if (bq.classList.contains('hf-skip-stats')) { el.style.display = 'none'; return; }

      var allTimeSum = 0;
      var monthlySum = 0;
      var hasHF = false, hasMS = false, hasModel = false, hasDataset = false;
      var detailLines = [];

      var msFixedAdded = false;
      Array.from(bq.querySelectorAll('a[href*="huggingface.co"], a[href*="modelscope.cn"]')).forEach(function(a) {
        var url = a.href;

        // emotion2vec ModelScope 固定值
        if (url.indexOf('modelscope.cn') >= 0 && url.indexOf('emotion2vec') >= 0) {
          hasMS = true;
          if (!msFixedAdded) {
            allTimeSum += MODELSCOPE_FIXED;
            msFixedAdded = true;
            detailLines.push({
              name: 'emotion2vec (ModelScope)',
              allTime: MODELSCOPE_FIXED,
              monthly: 0,
              fixed: true
            });
          }
          return;
        }

        // HF Collection 自动展开
        var col = parseCollection(a);
        if (col) {
          hasHF = true;
          hasModel = true;
          var colKey = col.owner + '/' + col.slug;
          var models = collectionModelsMap[colKey] || [];
          models.forEach(function(m) {
            var s = statsMap[m.type + ':' + m.id];
            if (!s) return;
            allTimeSum += s.allTime;
            monthlySum += s.monthly;
            detailLines.push({
              name: m.id,
              allTime: s.allTime,
              monthly: s.monthly,
              fixed: false
            });
          });
          return;
        }

        // 普通 HF repo
        var r = parseHFRepo(a);
        if (!r) return;
        hasHF = true;
        if (r.type === 'models') hasModel = true;
        if (r.type === 'datasets') hasDataset = true;
        var s = statsMap[r.type + ':' + r.id];
        if (!s) return;
        allTimeSum += s.allTime;
        monthlySum += s.monthly;
        detailLines.push({
          name: r.id,
          allTime: s.allTime,
          monthly: s.monthly,
          fixed: false
        });
      });

      // 判断资源类型与平台
      var resourceType = '';
      if (hasModel && hasDataset) resourceType = lang === 'zh' ? '开源资源' : 'Open-source resources';
      else if (hasDataset) resourceType = lang === 'zh' ? '开源数据集' : 'Open-source datasets';
      else resourceType = lang === 'zh' ? '开源模型' : 'Open-source models';

      var platform = '';
      if (hasHF && hasMS) platform = lang === 'zh' ? '在HuggingFace和ModelScope' : 'on HuggingFace and ModelScope';
      else if (hasMS) platform = lang === 'zh' ? '在ModelScope' : 'on ModelScope';
      else platform = lang === 'zh' ? '在HuggingFace' : 'on HuggingFace';

      var sentences = [];
      if (allTimeSum >= THRESHOLD_ALL) {
        if (lang === 'zh') {
          sentences.push(resourceType + platform + '总下载量超<strong>' + fmt(allTimeSum) + '</strong>次');
        } else {
          sentences.push(resourceType + ' ' + platform + ' have over <strong>' + fmt(allTimeSum) + '</strong> downloads');
        }
      }
      if (monthlySum >= THRESHOLD_MONTH) {
        if (lang === 'zh') {
          if (allTimeSum >= THRESHOLD_ALL) {
            sentences.push('上月下载量超<strong>' + fmt(monthlySum) + '</strong>次');
          } else {
            sentences.push(resourceType + platform + '上月下载量超<strong>' + fmt(monthlySum) + '</strong>次');
          }
        } else {
          if (allTimeSum >= THRESHOLD_ALL) {
            sentences.push('with over <strong>' + fmt(monthlySum) + '</strong> downloads last month');
          } else {
            sentences.push(resourceType + ' ' + platform + ' had over <strong>' + fmt(monthlySum) + '</strong> downloads last month');
          }
        }
      }

      if (sentences.length > 0) {
        var tooltipContent = '';
        if (detailLines.length > 0) {
          tooltipContent = detailLines.map(function(d) {
            var monthStr = d.fixed ? '' : ' <span style="color:#888;">(' + i18n.detailMonthly + ': ' + d.monthly.toLocaleString() + ')</span>';
            return '<div class="hf-tooltip-row"><span class="hf-tooltip-label">' + d.name + '</span><span class="hf-tooltip-num">' + d.allTime.toLocaleString() + '</span></div>' + monthStr;
          }).join('');
        }
        var infoHtml = tooltipContent ? '<span class="hf-info-wrap"><span class="hf-info">&#9432;</span><span class="hf-tooltip">' + tooltipContent + '</span></span>' : '';
        el.style.cssText = 'color:#c41e3a;font-size:0.95em;font-weight:500;';
        el.innerHTML = sentences.join(lang === 'zh' ? '；' : '; ') + infoHtml;
      } else {
        el.style.display = 'none';
      }
    });
  }

  // 获取 collection 中的模型列表
  function fetchCollection(col) {
    var url = 'https://huggingface.co/api/collections/' + col.owner + '/' + col.slug;
    return fetch(url, { cache: 'no-store' })
      .then(function(r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function(data) {
        var items = (data.items || []).filter(function(item) {
          return item.type === 'model' || item.type === 'dataset';
        }).map(function(item) {
          return { type: item.type === 'dataset' ? 'datasets' : 'models', id: item.id };
        });
        return { key: col.owner + '/' + col.slug, items: items };
      })
      .catch(function() { return { key: col.owner + '/' + col.slug, items: [] }; });
  }

  // 同时请求官网和镜像，2秒超时；迟到结果单独回调更新
  function fetchRepo(repo, onLateResult) {
    var path = repo.type + '/' + repo.id + '?expand[]=downloadsAllTime&expand[]=downloads';
    var urlOfficial = 'https://huggingface.co/api/' + path;
    var urlMirror   = 'https://hf-mirror.com/api/' + path;
    var TIMEOUT = 2000;

    return new Promise(function(resolve) {
      var done = false;
      var errors = 0;
      var timer = setTimeout(function() {
        if (!done) { done = true; resolve(null); }
      }, TIMEOUT);

      function onSuccess(data) {
        clearTimeout(timer);
        var result = {
          key: repo.type + ':' + repo.id,
          allTime: data.downloadsAllTime || data.downloads || 0,
          monthly: data.downloads || 0
        };
        if (!done) { done = true; resolve(result); }
        else { onLateResult(result); }
      }

      function onError() {
        errors++;
        if (errors >= 2) {
          clearTimeout(timer);
          if (!done) { done = true; resolve(null); }
        }
      }

      function tryFetch(url) {
        fetch(url, { cache: 'no-store' })
          .then(function(r) { return r.ok ? r.json() : Promise.reject(); })
          .then(onSuccess)
          .catch(onError);
      }
      tryFetch(urlOfficial);
      tryFetch(urlMirror);
    });
  }

  function fetchAll(initialAll, initialMonth) {
    var startTime = Date.now();
    var finalStatsMap = {};
    var displayedTotalAll = initialAll || 0;
    var displayedTotalMonth = initialMonth || 0;

    function recalcAndRender() {
      var all = 0, month = 0, count = 0;
      for (var key in finalStatsMap) {
        var s = finalStatsMap[key];
        all += s.allTime; month += s.monthly; count++;
      }
      all += MODELSCOPE_FIXED;
      // 只增不减：panel 和顶部文字不显示中间的小值
      if (all > displayedTotalAll) displayedTotalAll = all;
      if (month > displayedTotalMonth) displayedTotalMonth = month;
      renderSummary(displayedTotalAll, displayedTotalMonth, count, false);
      renderNotes(finalStatsMap);
      updateIntro(displayedTotalAll);
      return { totalAllTime: displayedTotalAll, totalMonthly: displayedTotalMonth, count: count };
    }

    function fetchRepos() {
      var promises = repoList.map(function(repo) {
        return fetchRepo(repo, function(data) {
          // late result 只更新项目卡片，不更新 panel 和顶部文字
          if (data) { finalStatsMap[data.key] = data; renderNotes(finalStatsMap); }
        });
      });

      Promise.all(promises).then(function(items) {
        items.forEach(function(x) { if (x) finalStatsMap[x.key] = x; });
        var result = recalcAndRender();
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({
            time: Date.now(),
            totalAllTime: result.totalAllTime,
            totalMonthly: result.totalMonthly,
            count: result.count,
            statsMap: finalStatsMap
          }));
        } catch(e) {}
        console.log('[HF Stats] done: ' + result.count + '/' + repoList.length + ', ' + (Date.now() - startTime) + 'ms');
      });
    }

    // 如果有 collection，先获取 collection 内容
    if (collectionList.length > 0) {
      Promise.all(collectionList.map(fetchCollection)).then(function(results) {
        results.forEach(function(res) {
          collectionModelsMap[res.key] = res.items;
          res.items.forEach(function(m) {
            var key = m.type + ':' + m.id;
            if (!repoMap[key]) {
              repoMap[key] = m;
              repoList.push(m);
            }
          });
        });
        fetchRepos();
      });
    } else {
      fetchRepos();
    }
  }

  // 尝试读取缓存先显示
  var cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch(e) {}

  if (cached && (Date.now() - cached.time) < CACHE_TTL) {
    renderSummary(cached.totalAllTime, cached.totalMonthly, cached.count, true);
    if (cached.statsMap) renderNotes(cached.statsMap);
    updateIntro(cached.totalAllTime);
    fetchAll(cached.totalAllTime, cached.totalMonthly);
  } else {
    document.getElementById('hf-stats-result').innerHTML = '<span style="color:#888;">' + i18n.loading + '</span>';
    fetchAll();
  }
})();
