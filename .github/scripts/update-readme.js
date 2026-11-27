const fs = require('fs');

module.exports = async ({ github, context }) => {
  const tick = String.fromCharCode(96);
  const username = context.repo.owner;
  const profileRepo = (username + '/' + username).toLowerCase();

  // 1. 내 계정의 Projects V2 보드에서 Issue + DraftIssue 모든 항목과 Status 가져오기
  const projectQuery = [
    'query {',
    '  viewer {',
    '    projectsV2(first: 10) {',
    '      nodes {',
    '        title',
    '        items(first: 100) {',
    '          nodes {',
    '            fieldValues(first: 20) {',
    '              nodes {',
    '                ... on ProjectV2ItemFieldSingleSelectValue { name }',
    '                ... on ProjectV2ItemFieldTextValue { text }',
    '              }',
    '            }',
    '            content {',
    '              ... on Issue {',
    '                title url state',
    '                repository { name nameWithOwner }',
    '              }',
    '              ... on DraftIssue {',
    '                title',
    '              }',
    '            }',
    '          }',
    '        }',
    '      }',
    '    }',
    '  }',
    '}'
  ].join('\n');

  const boardTasks = [];
  const boardUrlSet = new Set();

  try {
    const res = await github.graphql(projectQuery);
    const projects = res.viewer?.projectsV2?.nodes || [];

    for (const proj of projects) {
      const items = proj.items?.nodes || [];
      for (const item of items) {
        const content = item.content;
        if (!content || !content.title) continue;

        // 닫힌 이슈나 프로필 저장소 논문 이슈 제외
        if (content.url) {
          if (content.state !== 'OPEN') continue;
          if (content.repository?.nameWithOwner?.toLowerCase() === profileRepo) continue;
        }

        // 모든 필드에서 Status 값 찾기
        let rawStatus = '';
        for (const f of (item.fieldValues?.nodes || [])) {
          const val = (f?.name || f?.text || '').trim();
          if (val && val !== content.title) {
            rawStatus = val;
            break;
          }
        }

        const lower = rawStatus.toLowerCase();
        if (lower.includes('done') || lower.includes('review')) continue;

        let badge = '📌';
        let priority = 4;
        if (lower.includes('in progress') || lower.includes('inprogress')) {
          badge = '🚧';
          priority = 1;
        } else if (lower.includes('todo') || lower.includes('to do')) {
          badge = '📝';
          priority = 2;
        } else if (lower.includes('backlog')) {
          badge = '📦';
          priority = 3;
        }

        if (content.url) boardUrlSet.add(content.url);

        boardTasks.push({
          badge,
          priority,
          repoName: content.repository?.name || proj.title || 'Project',
          title: content.title,
          url: content.url || ''
        });
      }
    }
  } catch (e) {
    console.log('Projects 조회 에러:', e.message);
  }

  // 1-2. 보드에 안 올라간 일반 공개 저장소 Open 이슈도 함께 포함
  const { data: searchRes } = await github.rest.search.issuesAndPullRequests({
    q: 'user:' + username + ' is:issue is:open is:public',
    sort: 'updated',
    order: 'desc',
    per_page: 50
  });

  for (const issue of searchRes.items) {
    const repoFullName = issue.repository_url.split('/repos/').pop().toLowerCase();
    if (repoFullName === profileRepo) continue;
    if (boardUrlSet.has(issue.html_url)) continue;

    boardTasks.push({
      badge: '📌',
      priority: 4,
      repoName: issue.repository_url.split('/').pop(),
      title: issue.title,
      url: issue.html_url
    });
  }

  boardTasks.sort((a, b) => a.priority - b.priority);

  let todoList = '';
  if (boardTasks.length === 0) {
    todoList = '- No open tasks 🎉';
  } else {
    todoList = boardTasks.map(t => {
      const linkText = t.url ? '[' + t.title + '](' + t.url + ')' : t.title;
      return '- ' + t.badge + ' **[' + t.repoName + ']** ' + linkText;
    }).join('\n');
  }

  // 2. 프로필 저장소 논문 목록 & 키워드 집계
  const { data: paperIssues } = await github.rest.issues.listForRepo({
    owner: username,
    repo: username,
    state: 'all',
    sort: 'updated',
    direction: 'desc',
    per_page: 100
  });

  const activePapers = paperIssues.filter(issue => !issue.pull_request);

  const keywordCounts = {};
  activePapers.forEach(issue => {
    if (!issue.body) return;
    const match = issue.body.match(/\*\*Keywords\*\*\s*:\s*(.+)/i);
    const rawKeywords = match ? match.at(1) : null;
    if (rawKeywords) {
      rawKeywords.split(',').forEach(raw => {
        const kw = raw.trim();
        if (kw) {
          const key = kw.toLowerCase();
          if (!keywordCounts[key]) keywordCounts[key] = { label: kw, count: 0 };
          keywordCounts[key].count += 1;
        }
      });
    }
  });

  const topKeywords = Object.values(keywordCounts)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map(item => tick + item.label + tick);

  const keywordLine = topKeywords.length > 0
    ? '- 🏷️ ' + topKeywords.join(', ')
    : '- 🏷️ No keywords yet';

  const isPaperDone = (issue) => issue.state === 'closed';
  const doneCount = activePapers.filter(isPaperDone).length;

  let paperList = '';
  if (activePapers.length === 0) {
    paperList = '- No papers logged yet 📚';
  } else {
    const sortedPapers = activePapers.sort((a, b) => {
      const aDone = isPaperDone(a);
      const bDone = isPaperDone(b);
      if (aDone === bDone) return 0;
      return aDone ? 1 : -1;
    });

    const unit = doneCount === 1 ? 'paper' : 'papers';
    const summaryLine = tick + 'Total Completed: ' + doneCount + ' ' + unit + tick + '\n';
    const itemsText = sortedPapers.slice(0, 15).map(issue => {
      const done = isPaperDone(issue);
      const badge = done ? '✅' : '📖';
      return '- ' + badge + ' [' + issue.title + '](' + issue.html_url + ')';
    }).join('\n');

    paperList = summaryLine + '\n' + itemsText;
  }

  // 3. README.md 업데이트
  let readme = fs.readFileSync('README.md', 'utf8');
  readme = readme.replace(
    /<!-- START_KEYWORDS -->[\s\S]*<!-- END_KEYWORDS -->/,
    '<!-- START_KEYWORDS -->\n' + keywordLine + '\n<!-- END_KEYWORDS -->'
  );
  readme = readme.replace(
    /<!-- START_TODO_ISSUES -->[\s\S]*<!-- END_TODO_ISSUES -->/,
    '<!-- START_TODO_ISSUES -->\n' + todoList + '\n<!-- END_TODO_ISSUES -->'
  );
  readme = readme.replace(
    /<!-- START_PAPERS -->[\s\S]*<!-- END_PAPERS -->/,
    '<!-- START_PAPERS -->\n' + paperList + '\n<!-- END_PAPERS -->'
  );

  fs.writeFileSync('README.md', readme);
};
